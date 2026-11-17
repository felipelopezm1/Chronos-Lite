// Where the engine and each brain's files are. Lite's own home comes first; then the full Chronos home, whose
// files are used in place, read-only, when they are the very files forge/brains.json pins (same size, same
// sha256): they are never copied, moved, renamed or deleted, and nothing is ever written there
// (docs/decisions/0019). What was checked is kept in Lite's home as reuse.json, so the runtime finds a reused
// file without hashing gigabytes at every start. The installer (scripts/install.sh) and the doctor
// (scripts/doctor.mjs) do the hashing; the runtime (runtime/brains.mjs) only reads the record.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { engineFile } from "./platform.mjs";

/** the record of what was checked, under Lite's home */
export const RECORD = "reuse.json";
/** the marker an installed engine folder carries (the same shape full Chronos writes) */
export const ENGINE_MARKER = "chronos-engine.json";
/** where the brains come from; HF_ENDPOINT names a mirror */
export const MODEL_HOST = "https://huggingface.co";

/** the three sets the installer takes: none, minimal (the 0.8B alone) and all */
export const SETS = ["none", "minimal", "all"];

/** the brains a set names, from the catalogue */
export function brainsOfSet(catalogue, set = "all") {
  if (!SETS.includes(set)) throw new Error(`no model set "${set}": use ${SETS.join(", ")}`);
  if (set === "none") return [];
  if (set === "minimal") return catalogue.brains.filter((b) => b.role === "offspring");
  return [...catalogue.brains];
}

/** the files a brain needs: its model, and its vision projector when it has one */
export function filesOf(brain, { host = process.env.HF_ENDPOINT || MODEL_HOST } = {}) {
  const url = (name) => `${host.replace(/\/+$/, "")}/${brain.repo}/resolve/main/${name}`;
  const out = [{ brain: brain.id, kind: "model", name: brain.file, bytes: brain.bytes, sha256: brain.sha256, url: url(brain.file) }];
  if (brain.mmproj && brain.vision) out.push({ brain: brain.id, kind: "mmproj", name: brain.mmproj, bytes: brain.mmprojBytes ?? null, sha256: brain.mmprojSha256 ?? null, url: url(brain.mmproj) });
  return out;
}

/** a file's sha256, read as a stream */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** whether p is inside dir (or is dir) */
export function inside(p, dir) {
  if (!p || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** reuse.json under home, or an empty record */
export function readRecord(home) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(home, RECORD), "utf8"));
    if (r && typeof r === "object") return { version: 1, engine: r.engine ?? null, files: r.files && typeof r.files === "object" ? r.files : {} };
  } catch {
    /* none yet, or unreadable: nothing is vouched for */
  }
  return { version: 1, engine: null, files: {} };
}

/** write reuse.json, whole, under home and nowhere else */
export function writeRecord(home, record) {
  const file = path.join(home, RECORD);
  if (!inside(file, home)) throw new Error(`refusing to write the record outside ${home}`);
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ about: "What Chronos Lite checked and may use: each file by its path, size, time and sha256; the engine by its folder and build. scripts/install.sh writes it.", ...record }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** where a file may be, in order: Lite's own models folder, then the full Chronos home's (when reuse is on) */
export function candidates(name, { home, reuseHome = null }) {
  const out = [{ where: "lite", path: path.join(home, "models", name) }];
  if (reuseHome && path.resolve(reuseHome) !== path.resolve(home)) out.push({ where: "chronos", path: path.join(reuseHome, "models", name) });
  return out;
}

function statOf(p) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** a record entry still vouches for the file at p: the same path, size, time and pinned sha256 */
function vouched(entry, p, st, sha256) {
  return !!entry && !!st && path.resolve(entry.path) === path.resolve(p) && entry.bytes === st.size && entry.mtimeMs === Math.floor(st.mtimeMs) && !!sha256 && entry.sha256 === sha256;
}

/**
 * Find one file by its pinned sha256: Lite's home first, then the full Chronos home. Each candidate is checked by
 * size, then by sha256 (skipped when the record vouches for that very file; verify false skips it too, for a quick
 * look). Returns { found, rejected, entry }: found is { where, path, cached, checked } or null; rejected lists each
 * candidate that was there but not the pinned file, with why; entry is the record line to keep for the found one.
 * Reads only; writes nothing anywhere.
 */
export async function findFile(file, { home, reuseHome = null, record = readRecord(home), hash = sha256File, verify = true } = {}) {
  const rejected = [];
  for (const c of candidates(file.name, { home, reuseHome })) {
    const st = statOf(c.path);
    if (!st) continue;
    if (file.bytes != null && st.size !== file.bytes) {
      rejected.push({ ...c, why: `${st.size} bytes, not the ${file.bytes} pinned` });
      continue;
    }
    const prior = record.files?.[file.name];
    const cached = vouched(prior, c.path, st, file.sha256);
    if (!cached && !verify) return { found: { where: c.where, path: c.path, cached: false, checked: false }, rejected, entry: null };
    if (!cached) {
      if (!file.sha256) {
        rejected.push({ ...c, why: "the catalogue pins no sha256 for it" });
        continue;
      }
      const got = await hash(c.path);
      if (got !== file.sha256) {
        rejected.push({ ...c, why: `sha256 ${got.slice(0, 12)}... is not the pinned ${file.sha256.slice(0, 12)}...` });
        continue;
      }
    }
    const entry = { path: c.path, where: c.where, bytes: st.size, mtimeMs: Math.floor(st.mtimeMs), sha256: file.sha256 };
    return { found: { where: c.where, path: c.path, cached, checked: true }, rejected, entry };
  }
  return { found: null, rejected, entry: null };
}

/**
 * The runtime's quick look, with no hashing. A file the record names is used where the record says, while it is
 * still the very file that was checked (the same path, size, time and sha256) and inside its home: Lite's own, or the
 * full Chronos home's when reuse is on. Without a record line, Lite's own copy is used when it is there. Returns
 * { where, path } or null.
 */
export function resolveFile(file, { home, reuseHome = null, record = readRecord(home) } = {}) {
  const entry = record.files?.[file.name];
  if (entry?.path) {
    const homeOf = entry.where === "lite" ? home : entry.where === "chronos" ? reuseHome : null;
    if (homeOf && inside(entry.path, homeOf) && vouched(entry, entry.path, statOf(entry.path), file.sha256)) return { where: entry.where, path: entry.path };
  }
  const own = path.join(home, "models", file.name);
  return statOf(own) ? { where: "lite", path: own } : null;
}

/** the build an engine folder is, from its marker, else from `llama-server --version`; null when neither says */
export function engineBuildOf(dir, { platform = process.platform, run = runVersion } = {}) {
  const bin = path.join(dir, engineFile(platform));
  if (!statOf(bin)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, ENGINE_MARKER), "utf8"));
    if (m?.build) return { build: m.build, key: m.key ?? null, from: "marker" };
  } catch {
    /* no marker: ask the binary */
  }
  const text = run(bin) ?? "";
  const n = text.match(/build (\d+)/)?.[1] ?? text.match(/version:\s*(\d+)/)?.[1];
  return n ? { build: `b${n}`, key: null, from: "version" } : null;
}

function runVersion(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
  }
}

/**
 * Find the engine: Lite's own bin/llama when it holds llama-server, else the full Chronos home's bin/llama when it
 * is the same build for this platform. Returns { where, dir, build } or { where: null, dir: Lite's, why }.
 */
export function findEngine({ home, reuseHome = null, build, key, platform = process.platform, run } = {}) {
  const own = path.join(home, "bin", "llama");
  const mine = engineBuildOf(own, { platform, run });
  if (mine) return { where: "lite", dir: own, build: mine.build };
  if (reuseHome && path.resolve(reuseHome) !== path.resolve(home)) {
    const theirs = path.join(reuseHome, "bin", "llama");
    const b = engineBuildOf(theirs, { platform, run });
    if (b && b.build === build && (!b.key || !key || b.key === key)) return { where: "chronos", dir: theirs, build: b.build };
    if (b) return { where: null, dir: own, why: `the full Chronos engine is ${b.build}${b.key ? ` for ${b.key}` : ""}, not ${build}${key ? ` for ${key}` : ""}` };
  }
  return { where: null, dir: own, why: "no engine yet" };
}

/**
 * The runtime's engine folder, with no process run: Lite's own when it holds llama-server, else the one the record
 * names inside the full Chronos home when it is still there and the same build, else Lite's own (missing).
 */
export function resolveEngineDir({ home, reuseHome = null, record = readRecord(home), build, platform = process.platform } = {}) {
  const own = path.join(home, "bin", "llama");
  if (statOf(path.join(own, engineFile(platform)))) return own;
  const e = record.engine;
  if (reuseHome && e?.where === "chronos" && inside(e.dir, reuseHome) && (!build || e.build === build) && statOf(path.join(e.dir, engineFile(platform)))) return e.dir;
  return own;
}

/**
 * What the installer will do, decided without writing anything: for the engine and every file of the set, have
 * (Lite's own, checked), reuse (the full Chronos home's, checked, used in place) or fetch (into Lite's home).
 * Returns { engine, files, record, fetchBytes }; record is the reuse.json to keep when the plan is carried out.
 */
export async function planInstall({ catalogue, home, reuseHome = null, set = "all", key, platform = process.platform, hash, run, record = readRecord(home) } = {}) {
  const engineCat = catalogue.engine ?? {};
  const asset = engineCat.assets?.[key] ?? null;
  const e = findEngine({ home, reuseHome, build: engineCat.build, key, platform, run });
  const engine = e.where
    ? { action: e.where === "lite" ? "have" : "reuse", dir: e.dir, build: e.build }
    : asset
      ? { action: "fetch", dir: e.dir, build: engineCat.build, asset: { ...asset, key }, note: e.why }
      : { action: "none", dir: e.dir, why: `llama.cpp ${engineCat.build} has no release file for ${key}: build it and put llama-server in ${e.dir}` };
  const next = { version: 1, engine: e.where ? { where: e.where, dir: e.dir, build: e.build } : null, files: { ...record.files } };
  const files = [];
  let fetchBytes = engine.action === "fetch" ? asset.bytes ?? 0 : 0;
  for (const brain of brainsOfSet(catalogue, set)) {
    for (const f of filesOf(brain)) {
      const r = await findFile(f, { home, reuseHome, record, hash });
      if (r.found) {
        next.files[f.name] = r.entry;
        files.push({ ...f, action: r.found.where === "lite" ? "have" : "reuse", path: r.found.path, cached: r.found.cached, rejected: r.rejected });
      } else {
        fetchBytes += f.bytes ?? 0;
        files.push({ ...f, action: "fetch", path: path.join(home, "models", f.name), rejected: r.rejected });
      }
    }
  }
  return { engine, files, record: next, fetchBytes };
}
