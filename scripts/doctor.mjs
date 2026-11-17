#!/usr/bin/env node
/**
 * The doctor: what this computer has for Chronos Lite, read without changing anything. Node's version, the engine
 * (found where, which build), each brain's files (found where, checked by sha256), the service's and the brains'
 * ports, the card lock, and the GPU. Zero dependencies.
 *
 *   node scripts/doctor.mjs            the report, in words
 *   node scripts/doctor.mjs --json     the same as JSON
 *   node scripts/doctor.mjs --quick    sizes only, no sha256 (files the record vouches for still count as checked)
 *
 * The installer asks it for the plan too (docs/install.md):
 *
 *   node scripts/doctor.mjs --plan [--models none|minimal|all] [--record]
 *
 * prints one tab-separated line per action (engine and files: have, reuse, fetch) for scripts/install.sh, and with
 * --record keeps what it checked in <Lite home>/reuse.json. Nothing is ever written in the full Chronos home.
 * Homes: CHRONOS_LITE_HOME (or --home) and CHRONOS_HOME (or --reuse-home; --no-reuse reads Lite's home only).
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brainsOfSet, filesOf, findEngine, findFile, planInstall, readRecord, writeRecord } from "../runtime/models.mjs";
import { cardHome, cardState, chronosHome, liteHome, platformOf } from "../runtime/platform.mjs";
import { readCardLock } from "../runtime/cardlock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NODE_MIN = 22;
const SERVICE_PORT = Number(process.env.CHRONOS_LITE_PORT) || 7778;

/** --flag value and --flag pairs, in order */
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) o._.push(a);
    else if (["--json", "--quick", "--plan", "--record", "--no-reuse"].includes(a)) o[a.slice(2)] = true;
    else o[a.slice(2)] = argv[++i];
  }
  return o;
}

function loadCatalogue(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** whether a TCP port on 127.0.0.1 is free to listen on */
export function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** who answers /health on a port, in a few words, or null */
async function whoIs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    return h?.edition === "lite" ? `${h.name ?? "Chronos Lite"} (running)` : h?.kind ? `a ${h.kind} service` : "something that answers /health";
  } catch {
    return null;
  }
}

const gb = (n) => (n == null ? "?" : `${(n / 1e9).toFixed(2)} GB`);

/** the doctor's findings, as data */
export async function examine({ catalogue, home, reuseHome, quick = false, key = platformOf().key, ports = true, hardware = true } = {}) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const record = readRecord(home);
  const engineCat = catalogue.engine ?? {};
  const e = findEngine({ home, reuseHome, build: engineCat.build, key });
  const brains = [];
  for (const b of brainsOfSet(catalogue, "all")) {
    const files = [];
    for (const f of filesOf(b)) {
      const r = await findFile(f, { home, reuseHome, record, verify: !quick });
      files.push({
        name: f.name,
        kind: f.kind,
        bytes: f.bytes,
        found: !!r.found,
        where: r.found?.where ?? null,
        path: r.found?.path ?? null,
        verified: !r.found ? null : r.found.cached ? "record" : r.found.checked ? "sha256" : "size",
        rejected: r.rejected.map(({ where, path: p, why }) => ({ where, path: p, why })),
      });
    }
    brains.push({ id: b.id, role: b.role, port: b.port, ok: files.every((f) => f.found), files });
  }
  const portRows = [];
  if (ports) {
    for (const [what, port] of [["service", SERVICE_PORT], ...catalogue.brains.map((b) => [b.id, b.port])]) {
      const free = await portFree(port);
      portRows.push({ what, port, free, holder: free ? null : await whoIs(port) });
    }
  }
  const lockHome = cardHome();
  const lock = readCardLock(lockHome);
  let gpu = null;
  if (hardware) {
    try {
      const { readHardware } = await import("../runtime/hardware.mjs");
      const hw = readHardware();
      gpu = { name: hw?.gpu?.name ?? hw?.vram?.card ?? null, vramMiB: hw?.vram?.totalMiB ?? 0, backend: engineCat.assets?.[key]?.backend ?? null };
    } catch {
      gpu = null;
    }
  }
  const service = portRows.find((p) => p.what === "service");
  const ok = nodeMajor >= NODE_MIN && !!e.where && brains.some((b) => b.ok) && (!service || service.free || /Chronos Lite|Lite/.test(service.holder ?? ""));
  return {
    ok,
    node: { version: process.versions.node, ok: nodeMajor >= NODE_MIN, need: `>=${NODE_MIN}` },
    platform: key,
    homes: { lite: home, reuse: reuseHome, cardLock: lockHome },
    engine: { found: !!e.where, where: e.where, dir: e.dir, build: e.build ?? null, want: engineCat.build, why: e.why ?? null },
    brains,
    ports: portRows,
    card: cardState(lock),
    gpu,
  };
}

function report(d) {
  const lines = [];
  const mark = (good) => (good ? "ok  " : "--  ");
  lines.push(`Chronos Lite doctor (${d.platform})`);
  lines.push(`${mark(d.node.ok)}node ${d.node.version} (needs ${d.node.need})`);
  lines.push(`    home ${d.homes.lite}${d.homes.reuse ? `; reuses from ${d.homes.reuse} (read-only)` : "; reuse off"}`);
  lines.push(`${mark(d.engine.found)}engine ${d.engine.found ? `llama.cpp ${d.engine.build} in ${d.engine.dir} (${d.engine.where === "chronos" ? "the full Chronos one, in place" : "Lite's own"})` : `missing: ${d.engine.why}; wants ${d.engine.want}`}`);
  for (const b of d.brains) {
    for (const f of b.files) {
      const how = f.verified === "sha256" ? "sha256 checked" : f.verified === "record" ? "checked before (reuse.json)" : f.verified === "size" ? "size only (--quick)" : "";
      lines.push(`${mark(f.found)}${b.id} ${f.kind} ${f.name} ${gb(f.bytes)}: ${f.found ? `${f.where === "chronos" ? "reused from the full Chronos home" : "Lite's own"}, ${how}` : "missing"}`);
      for (const r of f.rejected) lines.push(`      not used: ${r.path} (${r.why})`);
    }
  }
  for (const p of d.ports) lines.push(`${mark(p.free || /Lite/.test(p.holder ?? ""))}port ${p.port} (${p.what}) ${p.free ? "free" : `in use${p.holder ? ` by ${p.holder}` : ""}`}`);
  const card = d.card.state === "held" ? `held by ${d.card.holder}` : d.card.state === "stale" ? `stale: ${d.card.holder}, nothing of it runs; Lite takes it over at its first GPU start` : "free";
  lines.push(`${mark(d.card.state !== "held")}card lock ${d.homes.cardLock}/run/gpu.lock: ${card}`);
  if (d.gpu) lines.push(`${mark(d.gpu.vramMiB > 0)}gpu ${d.gpu.name ?? "none seen"}${d.gpu.vramMiB ? `, ${d.gpu.vramMiB} MiB` : ""}${d.gpu.backend ? `, engine backend ${d.gpu.backend}` : ""}${d.gpu.vramMiB ? "" : ": brains run on the CPU"}`);
  lines.push(d.ok ? "ready: npm start (or chronos-lite start)" : "not ready: run scripts/install.sh (scripts/install.sh --dry-run shows what it would do)");
  return lines.join("\n");
}

/** the installer's plan, one tab-separated line per action */
export function planLines(plan) {
  // never an empty field: the shell reads these with IFS set to a tab, which folds empty fields away
  const t = (...xs) => xs.map((x) => String(x ?? "").replace(/[\t\n]/g, " ") || "-").join("\t");
  const out = [];
  const e = plan.engine;
  if (e.action === "fetch") out.push(t("engine", "fetch", e.dir, e.asset.url, e.asset.sha256, e.asset.name, e.asset.bytes, e.asset.format, e.build, e.asset.key));
  else if (e.action === "none") out.push(t("engine", "none", e.dir, e.why));
  else out.push(t("engine", e.action, e.dir, e.build));
  for (const f of plan.files) {
    for (const r of f.rejected ?? []) out.push(t("note", `not using ${r.path}: ${r.why}`));
    if (f.action === "fetch") out.push(t("file", "fetch", f.brain, f.name, f.path, f.url, f.sha256, f.bytes));
    else out.push(t("file", f.action, f.brain, f.name, f.path, f.cached ? "record" : "sha256", f.bytes));
  }
  out.push(t("total", "fetch", plan.fetchBytes));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const catalogue = loadCatalogue(o.catalogue ? path.resolve(o.catalogue) : path.join(ROOT, "forge", "brains.json"));
  const home = path.resolve(o.home ?? liteHome());
  const reuseHome = o["no-reuse"] || process.env.CHRONOS_LITE_REUSE === "0" ? null : path.resolve(o["reuse-home"] ?? chronosHome());
  const key = o.key ?? platformOf().key;
  if (o.plan) {
    const plan = await planInstall({ catalogue, home, reuseHome, set: o.models ?? "all", key });
    if (o.record) writeRecord(home, plan.record);
    console.log(o.json ? JSON.stringify(plan, null, 2) : planLines(plan).join("\n"));
    return 0;
  }
  const d = await examine({ catalogue, home, reuseHome, quick: !!o.quick, key });
  console.log(o.json ? JSON.stringify(d, null, 2) : report(d));
  return d.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`doctor: ${err?.message ?? err}`);
      process.exit(2);
    },
  );
}
