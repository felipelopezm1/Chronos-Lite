// The installer, the doctor and the chronos-lite command, run for real against temp homes: fake brain files whose
// sha256 the test computes, a fake engine, and downloads served from file:// URLs, so nothing is ever fetched from
// the network and no real home is read or written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = `${process.platform}-${process.arch}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lite-inst-${name}-`)));
const posix = process.platform !== "win32";

/** temp homes, a fake catalogue whose files and engine live in a file:// mirror, and helpers to place copies */
function world() {
  const base = tmp("w");
  const lite = path.join(base, "lite");
  const chronos = path.join(base, "chronos");
  const mirror = path.join(base, "mirror");
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, "forge", "brains.json"), "utf8"));
  const contents = {};
  for (const b of cat.brains) {
    contents[b.file] = Buffer.from(`fake gguf of ${b.id}\n`.repeat(50));
    b.bytes = contents[b.file].length;
    b.sha256 = sha(contents[b.file]);
    if (b.mmproj) {
      contents[b.mmproj] = Buffer.from(`fake projector of ${b.id}\n`);
      b.mmprojBytes = contents[b.mmproj].length;
      b.mmprojSha256 = sha(contents[b.mmproj]);
    }
    for (const name of [b.file, b.mmproj].filter(Boolean)) {
      const p = path.join(mirror, b.repo, "resolve", "main", name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents[name]);
    }
  }
  // the engine release: a tar.gz with one top folder holding llama-server, as llama.cpp's are
  const stage = path.join(base, "stage", "llama-b11669");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "llama-server"), "#!/bin/sh\necho 'version: 0.7.0-dev (build 11669, commit 0000000)'\n", { mode: 0o755 });
  const tarball = path.join(mirror, "llama.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(stage), "llama-b11669"]);
  const t = fs.readFileSync(tarball);
  cat.engine.assets[KEY] = { name: "llama-b11669-bin-test.tar.gz", url: pathToFileURL(tarball).href, bytes: t.length, sha256: sha(t), format: "tar.gz", backend: "none" };
  const catalogue = path.join(base, "brains.json");
  fs.writeFileSync(catalogue, JSON.stringify(cat));
  const put = (home, name, body = contents[name]) => {
    fs.mkdirSync(path.join(home, "models"), { recursive: true });
    fs.writeFileSync(path.join(home, "models", name), body);
  };
  const engineIn = (home, build = "b11669") => {
    const dir = path.join(home, "bin", "llama");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "llama-server"), "#!/bin/sh\necho 'version: 0.7.0-dev (build 11669)'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "chronos-engine.json"), JSON.stringify({ id: "llama.cpp", build, key: KEY }));
  };
  const env = { ...process.env, CHRONOS_LITE_HOME: lite, CHRONOS_HOME: chronos, HF_ENDPOINT: pathToFileURL(mirror).href, CHRONOS_LITE_REUSE: "1" };
  const install = (...args) => spawnSync("sh", [path.join(ROOT, "scripts", "install.sh"), "--catalogue", catalogue, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { base, lite, chronos, mirror, cat, catalogue, contents, put, engineIn, env, install, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function snapshot(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${st.mode}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("install --dry-run: finds the full Chronos engine and brains, says it will reuse them, and touches nothing", { skip: !posix && "the installer is POSIX sh" }, () => {
  const w = world();
  try {
    for (const b of w.cat.brains) for (const n of [b.file, b.mmproj].filter(Boolean)) w.put(w.chronos, n);
    w.engineIn(w.chronos);
    const before = snapshot(w.chronos);
    const r = w.install("--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /engine {2}reuse {3}llama\.cpp b11669 in .*chronos\/bin\/llama/);
    for (const b of w.cat.brains) assert.match(r.stdout, new RegExp(`brain {3}reuse {3}${b.file.replace(/\./g, "\\.")} \\(${b.id}\\)`));
    assert.match(r.stdout, /to download: 0 file\(s\)/);
    assert.ok(!fs.existsSync(w.lite), "the dry run made no Lite home");
    assert.deepEqual(snapshot(w.chronos), before);
  } finally {
    w.done();
  }
});

test("install --dry-run: a wrong-hash copy is named and fetched instead; --models minimal asks for the 0.8B only", { skip: !posix && "the installer is POSIX sh" }, () => {
  const w = world();
  try {
    const four = w.cat.brains.find((b) => b.id === "qwen3.5-4b");
    w.put(w.chronos, four.file, Buffer.alloc(four.bytes, 7));
    let r = w.install("--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /note {4}not using .*Qwen3\.5-4B.*sha256 .* is not the pinned/);
    assert.match(r.stdout, new RegExp(`brain {3}fetch {3}${four.file.replace(/\./g, "\\.")} .* into .*lite/models/`));
    assert.match(r.stdout, /engine {2}fetch/);
    r = w.install("--dry-run", "--models", "minimal");
    assert.equal((r.stdout.match(/^brain /gm) ?? []).length, 1);
    assert.match(r.stdout, /Qwen3\.5-0\.8B/);
    r = w.install("--dry-run", "--models", "none");
    assert.equal((r.stdout.match(/^brain /gm) ?? []).length, 0);
    assert.ok(!fs.existsSync(w.lite));
  } finally {
    w.done();
  }
});

test("install: reuses what is pinned, downloads the rest into Lite's home by sha256, writes only there", { skip: !posix && "the installer is POSIX sh", timeout: 60_000 }, async () => {
  const w = world();
  try {
    const [nine, four, tiny] = ["qwen3.5-9b", "qwen3.5-4b", "qwen3.5-0.8b"].map((id) => w.cat.brains.find((b) => b.id === id));
    w.put(w.chronos, nine.file);
    w.put(w.chronos, nine.mmproj);
    w.put(w.chronos, four.file, Buffer.alloc(four.bytes, 1)); // wrong hash: fetched into Lite's home
    // a half-done download of the 0.8B is resumed
    fs.mkdirSync(path.join(w.lite, "downloads"), { recursive: true });
    fs.writeFileSync(path.join(w.lite, "downloads", `${tiny.file}.part`), w.contents[tiny.file].subarray(0, 100));
    const before = snapshot(w.chronos);
    const r = w.install();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(snapshot(w.chronos), before, "the full Chronos home is exactly as it was");
    assert.equal(sha(fs.readFileSync(path.join(w.lite, "models", four.file))), four.sha256);
    assert.equal(sha(fs.readFileSync(path.join(w.lite, "models", tiny.file))), tiny.sha256);
    assert.ok(!fs.existsSync(path.join(w.lite, "models", nine.file)), "the reused 9B is not copied");
    assert.ok(fs.existsSync(path.join(w.lite, "bin", "llama", "llama-server")), "the engine was unpacked");
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.lite, "bin", "llama", "chronos-engine.json"), "utf8")).build, "b11669");
    const rec = JSON.parse(fs.readFileSync(path.join(w.lite, "reuse.json"), "utf8"));
    assert.equal(rec.files[nine.file].where, "chronos");
    assert.equal(rec.files[nine.mmproj].where, "chronos");
    assert.equal(rec.files[four.file].where, "lite");
    assert.ok(fs.statSync(path.join(w.lite, "bin", "chronos-lite")).mode & 0o100, "the launcher is there");
    assert.deepEqual(fs.readdirSync(path.join(w.lite, "downloads")), [], "no partial file is left");
    // the brains module now runs the reused 9B in place
    const { Brains } = await import("../runtime/brains.mjs");
    const root = path.join(w.base, "root");
    fs.mkdirSync(path.join(root, "forge"), { recursive: true });
    fs.copyFileSync(w.catalogue, path.join(root, "forge", "brains.json"));
    const brains = new Brains({ root, home: w.lite, reuseHome: w.chronos, bus: { emit() {} }, hasCard: false, readJunction: () => NaN });
    assert.deepEqual(brains.list().map((b) => [b.id, b.present, b.where]), [["qwen3.5-9b", true, "chronos"], ["qwen3.5-4b", true, "lite"], ["qwen3.5-0.8b", true, "lite"]]);
    assert.equal(brains.modelPath(nine), path.join(w.chronos, "models", nine.file));
    // a second run has nothing to do
    const again = w.install("--dry-run");
    assert.match(again.stdout, /to download: 0 file\(s\)/);
    assert.match(again.stdout, /engine {2}have/);
  } finally {
    w.done();
  }
});

test("install: a download whose sha256 is not the pinned one is removed and the install fails", { skip: !posix && "the installer is POSIX sh", timeout: 60_000 }, () => {
  const w = world();
  try {
    w.engineIn(w.chronos);
    const tiny = w.cat.brains.find((b) => b.id === "qwen3.5-0.8b");
    // the mirror serves other bytes than the catalogue pins
    fs.writeFileSync(path.join(w.mirror, tiny.repo, "resolve", "main", tiny.file), Buffer.alloc(tiny.bytes, 9));
    const before = snapshot(w.chronos);
    const r = w.install("--models", "minimal");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sha256 .* is not the pinned/);
    assert.ok(!fs.existsSync(path.join(w.lite, "models", tiny.file)));
    assert.deepEqual(fs.readdirSync(path.join(w.lite, "downloads")), []);
    assert.deepEqual(snapshot(w.chronos), before);
  } finally {
    w.done();
  }
});

test("doctor --json: node, the engine, each file where it was found and how it was checked, the ports, the card", () => {
  const w = world();
  try {
    for (const b of w.cat.brains) for (const n of [b.file, b.mmproj].filter(Boolean)) w.put(w.chronos, n);
    w.engineIn(w.chronos);
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "doctor.mjs"), "--json", "--catalogue", w.catalogue], { env: w.env, encoding: "utf8" });
    const d = JSON.parse(out);
    assert.equal(d.node.ok, true);
    assert.equal(d.engine.where, "chronos");
    assert.ok(d.brains.every((b) => b.ok && b.files.every((f) => f.where === "chronos" && f.verified === "sha256")));
    assert.deepEqual(d.ports.map((p) => p.port), [7778, 7710, 7720, 7730]);
    assert.equal(d.homes.cardLock, w.chronos);
    assert.equal(d.card.lock, null);
    const human = spawnSync(process.execPath, [path.join(ROOT, "scripts", "doctor.mjs"), "--quick", "--no-reuse", "--catalogue", w.catalogue], { env: w.env, encoding: "utf8" });
    assert.equal(human.status, 1, "with reuse off nothing is here: not ready");
    assert.match(human.stdout, /engine missing/);
    assert.match(human.stdout, /not ready/);
  } finally {
    w.done();
  }
});

test("chronos-lite ask and status over HTTP, against the mock service", { timeout: 30_000 }, async () => {
  const port = await freePort();
  const mock = spawn(process.execPath, [path.join(ROOT, "scripts", "mock-runtime.mjs"), "--port", String(port), "--speed", "20", "--no-drop"], { stdio: "ignore" });
  try {
    const { main } = await import("./chronos-lite.mjs");
    const lines = [];
    const out = (s) => lines.push(s);
    for (let i = 0; i < 50 && (await main(["status", "--port", String(port)], { out: () => {} })) !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await main(["status", "--port", String(port)], { out }), 0);
    assert.match(lines.join("\n"), /on port \d+/);
    lines.length = 0;
    assert.equal(await main(["ask", "Count the stars", "--size", "s", "--port", String(port)], { out }), 0);
    assert.match(lines[0], /^q-\S+: size s/);
    assert.match(lines.join("\n"), /q-\S+: done/);
    assert.equal(await main(["ask", "--port", String(port)], { out: () => {} }), 2, "a task is needed");
  } finally {
    mock.kill();
  }
});

test("chronos-lite start, status and stop run the real service in a temp home", { skip: !posix && "signals", timeout: 60_000 }, async () => {
  const w = world();
  const port = await freePort();
  const saved = { ...process.env };
  // every home the service touches is a temp one: Lite's, the card lock's and the beacon's
  Object.assign(process.env, { CHRONOS_LITE_HOME: w.lite, CHRONOS_HOME: w.chronos, CHRONOS_LITE_PORT: String(port), HEPHAESTUS_ESTATE_DIR: path.join(w.base, "estate") });
  try {
    const { main } = await import("./chronos-lite.mjs");
    const lines = [];
    const out = (s) => lines.push(s);
    assert.equal(await main(["start"], { out }), 0, lines.join("\n"));
    assert.match(lines.at(-1), new RegExp(`started on http://127\\.0\\.0\\.1:${port}`));
    assert.equal(await main(["start"], { out }), 0);
    assert.match(lines.at(-1), /already running/);
    assert.equal(await main(["status"], { out }), 0);
    assert.equal(await main(["stop"], { out }), 0);
    assert.match(lines.at(-1), /stopped/);
    assert.equal(await main(["status"], { out }), 1);
    assert.ok(!fs.existsSync(path.join(w.chronos, "models")), "nothing was written in the full Chronos home");
    assert.deepEqual(fs.readdirSync(path.join(w.base, "estate", "runtimes")), [], "its beacon went with it");
  } finally {
    await (await import("./chronos-lite.mjs")).main(["stop"], { out: () => {} }).catch(() => {});
    for (const k of ["CHRONOS_LITE_HOME", "CHRONOS_HOME", "CHRONOS_LITE_PORT", "HEPHAESTUS_ESTATE_DIR"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    w.done();
  }
});
