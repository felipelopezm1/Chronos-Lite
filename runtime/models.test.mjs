import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brains, loadCatalogue } from "./brains.mjs";
import { brainsOfSet, candidates, engineBuildOf, filesOf, findEngine, findFile, inside, planInstall, readRecord, resolveEngineDir, resolveFile, sha256File, writeRecord, RECORD } from "./models.mjs";
import { engineFile } from "./platform.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = `${process.platform}-${process.arch}`;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `lite-models-${name}-`));

/** a Lite home, a full Chronos home and a catalogue whose three brains are small fake files with their real sha256 */
function world() {
  const lite = tmp("lite");
  const chronos = tmp("chronos");
  const cat = loadCatalogue(ROOT);
  const contents = {};
  for (const b of cat.brains) {
    contents[b.file] = `fake gguf of ${b.id}\n`;
    b.bytes = Buffer.byteLength(contents[b.file]);
    b.sha256 = sha(contents[b.file]);
    if (b.mmproj) {
      contents[b.mmproj] = `fake projector of ${b.id}\n`;
      b.mmprojBytes = Buffer.byteLength(contents[b.mmproj]);
      b.mmprojSha256 = sha(contents[b.mmproj]);
    }
  }
  const put = (home, name, text = contents[name]) => {
    fs.mkdirSync(path.join(home, "models"), { recursive: true });
    fs.writeFileSync(path.join(home, "models", name), text);
    return path.join(home, "models", name);
  };
  const root = tmp("root");
  fs.mkdirSync(path.join(root, "forge"));
  fs.writeFileSync(path.join(root, "forge", "brains.json"), JSON.stringify({ ...cat, home: lite }));
  return { lite, chronos, cat, contents, put, root, done: () => [lite, chronos, root].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

/** every file under dir with its size, time and mode, to prove nothing there changed */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = `${e.isDirectory() ? "d" : "f"}:${st.size}:${st.mtimeMs}:${st.mode}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function fakeEngine(dir, { build = "b11669", key = KEY, marker = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, engineFile());
  fs.writeFileSync(bin, "#!/bin/sh\necho 'version: 0.7.0-dev (build 11669, commit 0000000)'\n");
  fs.chmodSync(bin, 0o755);
  if (marker) fs.writeFileSync(path.join(dir, "chronos-engine.json"), JSON.stringify({ id: "llama.cpp", build, key }));
}

test("the sets: none, minimal is the 0.8B alone, all is the three; the 9B brings its projector", () => {
  const cat = loadCatalogue(ROOT);
  assert.deepEqual(brainsOfSet(cat, "none"), []);
  assert.deepEqual(brainsOfSet(cat, "minimal").map((b) => b.id), ["qwen3.5-0.8b"]);
  assert.equal(brainsOfSet(cat, "all").length, 3);
  assert.throws(() => brainsOfSet(cat, "some"), /no model set/);
  const nine = filesOf(cat.brains.find((b) => b.id === "qwen3.5-9b"), { host: "https://models.example" });
  assert.deepEqual(nine.map((f) => f.kind), ["model", "mmproj"]);
  assert.equal(nine[0].url, "https://models.example/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-UD-Q4_K_XL.gguf");
  for (const f of nine) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test("candidates: Lite's own home first, then the full Chronos home; never the same folder twice", () => {
  assert.deepEqual(candidates("a.gguf", { home: "/l", reuseHome: "/c" }).map((c) => c.where), ["lite", "chronos"]);
  assert.deepEqual(candidates("a.gguf", { home: "/l" }).map((c) => c.where), ["lite"]);
  assert.deepEqual(candidates("a.gguf", { home: "/l", reuseHome: "/l" }).map((c) => c.where), ["lite"]);
  assert.ok(inside("/c/models/a", "/c") && !inside("/c2/a", "/c") && !inside("/a", "/c"));
});

test("reuse by sha256: a file in the full Chronos home that is the pinned one is used where it is", async () => {
  const w = world();
  try {
    const f = filesOf(w.cat.brains.find((b) => b.id === "qwen3.5-0.8b"))[0];
    const where = w.put(w.chronos, f.name);
    assert.equal(await sha256File(where), f.sha256);
    const r = await findFile(f, { home: w.lite, reuseHome: w.chronos });
    assert.deepEqual(r.found, { where: "chronos", path: where, cached: false, checked: true });
    assert.equal(r.entry.sha256, f.sha256);
    assert.equal(r.entry.where, "chronos");
    const plan = await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "minimal", key: KEY });
    assert.equal(plan.files[0].action, "reuse");
    assert.equal(plan.files[0].path, where);
    assert.equal(plan.fetchBytes, plan.engine.action === "fetch" ? plan.engine.asset.bytes : 0, "nothing of the model is fetched");
  } finally {
    w.done();
  }
});

test("wrong-hash rejection: the same size with other bytes is refused, and the plan fetches into Lite's home", async () => {
  const w = world();
  try {
    const f = filesOf(w.cat.brains.find((b) => b.id === "qwen3.5-4b"))[0];
    const forged = "X".repeat(f.bytes);
    w.put(w.chronos, f.name, forged);
    const r = await findFile(f, { home: w.lite, reuseHome: w.chronos });
    assert.equal(r.found, null);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].where, "chronos");
    assert.match(r.rejected[0].why, /sha256 .* is not the pinned/);
    // a size that differs is refused before any hashing
    let hashed = 0;
    w.put(w.chronos, f.name, "short");
    const r2 = await findFile(f, { home: w.lite, reuseHome: w.chronos, hash: async () => (hashed++, f.sha256) });
    assert.equal(r2.found, null);
    assert.match(r2.rejected[0].why, /bytes, not the/);
    assert.equal(hashed, 0);
    const plan = await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "all", key: KEY });
    const row = plan.files.find((x) => x.name === f.name);
    assert.equal(row.action, "fetch");
    assert.equal(row.path, path.join(w.lite, "models", f.name), "the download goes to Lite's home");
    assert.ok(!plan.record.files[f.name], "a refused file is never recorded");
  } finally {
    w.done();
  }
});

test("fallback to Lite's home: its own good copy wins over the full home's, and a bad own copy falls through", async () => {
  const w = world();
  try {
    const f = filesOf(w.cat.brains.find((b) => b.id === "qwen3.5-0.8b"))[0];
    const theirs = w.put(w.chronos, f.name);
    const mine = w.put(w.lite, f.name);
    let r = await findFile(f, { home: w.lite, reuseHome: w.chronos });
    assert.equal(r.found.where, "lite");
    assert.equal(r.found.path, mine);
    // Lite's own copy is broken: the full home's good one is used, and the broken one is named
    fs.writeFileSync(mine, "Y".repeat(f.bytes));
    r = await findFile(f, { home: w.lite, reuseHome: w.chronos });
    assert.equal(r.found.where, "chronos");
    assert.equal(r.found.path, theirs);
    assert.equal(r.rejected[0].where, "lite");
    // the runtime follows the record, not the broken copy that happens to be in Lite's home
    writeRecord(w.lite, (await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "minimal", key: KEY })).record);
    assert.deepEqual(resolveFile(f, { home: w.lite, reuseHome: w.chronos }), { where: "chronos", path: theirs });
    // with reuse off, only Lite's home is read
    r = await findFile(f, { home: w.lite, reuseHome: null });
    assert.equal(r.found, null);
  } finally {
    w.done();
  }
});

test("the record: a vouched-for file is not hashed again; a changed one is", async () => {
  const w = world();
  try {
    const f = filesOf(w.cat.brains.find((b) => b.id === "qwen3.5-9b"))[0];
    const where = w.put(w.chronos, f.name);
    const first = await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "all", key: KEY });
    writeRecord(w.lite, first.record);
    let hashed = 0;
    const counting = async (p) => (hashed++, sha256File(p));
    const again = await findFile(f, { home: w.lite, reuseHome: w.chronos, hash: counting });
    assert.equal(again.found.cached, true);
    assert.equal(hashed, 0);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(where, later, later);
    const touched = await findFile(f, { home: w.lite, reuseHome: w.chronos, hash: counting });
    assert.equal(touched.found.cached, false);
    assert.equal(hashed, 1);
  } finally {
    w.done();
  }
});

test("resolveFile, the runtime's look: Lite's own by presence, the full home's only when the record vouches for it", async () => {
  const w = world();
  try {
    const f = filesOf(w.cat.brains.find((b) => b.id === "qwen3.5-0.8b"))[0];
    const theirs = w.put(w.chronos, f.name);
    assert.equal(resolveFile(f, { home: w.lite, reuseHome: w.chronos }), null, "not checked yet: not used");
    const plan = await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "minimal", key: KEY });
    writeRecord(w.lite, plan.record);
    assert.deepEqual(resolveFile(f, { home: w.lite, reuseHome: w.chronos }), { where: "chronos", path: theirs });
    assert.equal(resolveFile(f, { home: w.lite, reuseHome: null }), null, "reuse off");
    assert.equal(resolveFile(f, { home: w.lite, reuseHome: tmp("other") }), null, "a record entry outside the reuse home is not trusted");
    fs.writeFileSync(theirs, "Z".repeat(f.bytes));
    assert.equal(resolveFile(f, { home: w.lite, reuseHome: w.chronos }), null, "changed since it was checked");
    const mine = w.put(w.lite, f.name);
    assert.deepEqual(resolveFile(f, { home: w.lite, reuseHome: w.chronos }), { where: "lite", path: mine });
  } finally {
    w.done();
  }
});

test("the engine: the full home's is reused when it is the same build for this machine, else Lite fetches its own", () => {
  const w = world();
  try {
    const theirs = path.join(w.chronos, "bin", "llama");
    assert.equal(findEngine({ home: w.lite, reuseHome: w.chronos, build: "b11669", key: KEY }).where, null);
    fakeEngine(theirs);
    assert.deepEqual(findEngine({ home: w.lite, reuseHome: w.chronos, build: "b11669", key: KEY }), { where: "chronos", dir: theirs, build: "b11669" });
    const other = findEngine({ home: w.lite, reuseHome: w.chronos, build: "b11700", key: KEY });
    assert.equal(other.where, null);
    assert.match(other.why, /b11669.*not b11700/);
    assert.equal(findEngine({ home: w.lite, reuseHome: w.chronos, build: "b11669", key: "linux-riscv" }).where, null, "another platform's build");
    // no marker: the binary's --version says the build
    fs.rmSync(path.join(theirs, "chronos-engine.json"));
    assert.deepEqual(engineBuildOf(theirs, { run: () => "version: 0.7.0-dev (build 11669, commit 620d2225c)" }), { build: "b11669", key: null, from: "version" });
    assert.equal(engineBuildOf(theirs, { run: () => "garbage" }), null);
    // Lite's own wins
    fakeEngine(path.join(w.lite, "bin", "llama"));
    assert.equal(findEngine({ home: w.lite, reuseHome: w.chronos, build: "b11669", key: KEY }).where, "lite");
  } finally {
    w.done();
  }
});

test("resolveEngineDir: Lite's own, else the recorded full home's of the same build, else Lite's (missing)", () => {
  const w = world();
  try {
    const own = path.join(w.lite, "bin", "llama");
    const theirs = path.join(w.chronos, "bin", "llama");
    fakeEngine(theirs);
    assert.equal(resolveEngineDir({ home: w.lite, reuseHome: w.chronos, build: "b11669" }), own, "unrecorded: not used");
    writeRecord(w.lite, { version: 1, engine: { where: "chronos", dir: theirs, build: "b11669" }, files: {} });
    assert.equal(resolveEngineDir({ home: w.lite, reuseHome: w.chronos, build: "b11669" }), theirs);
    assert.equal(resolveEngineDir({ home: w.lite, reuseHome: w.chronos, build: "b12000" }), own, "the catalogue moved on");
    assert.equal(resolveEngineDir({ home: w.lite, reuseHome: null, build: "b11669" }), own, "reuse off");
    fakeEngine(own);
    assert.equal(resolveEngineDir({ home: w.lite, reuseHome: w.chronos, build: "b11669" }), own);
  } finally {
    w.done();
  }
});

test("no write to the full Chronos home: planning, recording and the brains reading leave it exactly as it was", async () => {
  const w = world();
  try {
    for (const b of w.cat.brains) for (const f of filesOf(b)) w.put(w.chronos, f.name);
    fs.writeFileSync(path.join(w.chronos, "models", w.cat.brains[1].file), "W".repeat(w.cat.brains[1].bytes)); // one bad
    fakeEngine(path.join(w.chronos, "bin", "llama"));
    for (const p of [path.join(w.chronos, "models"), ...fs.readdirSync(path.join(w.chronos, "models")).map((n) => path.join(w.chronos, "models", n))]) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o555 : 0o444);
    const before = snapshot(w.chronos);
    const plan = await planInstall({ catalogue: w.cat, home: w.lite, reuseHome: w.chronos, set: "all", key: KEY });
    assert.deepEqual(plan.files.map((f) => f.action), ["reuse", "reuse", "fetch", "reuse"]);
    assert.equal(plan.engine.action, "reuse");
    const written = writeRecord(w.lite, plan.record);
    assert.ok(inside(written, w.lite));
    const brains = new Brains({ root: w.root, home: w.lite, reuseHome: w.chronos, bus: { emit() {} }, hasCard: false, readJunction: () => NaN });
    const rows = brains.list();
    assert.deepEqual(rows.map((r) => [r.id, r.present, r.where]), [["qwen3.5-9b", true, "chronos"], ["qwen3.5-4b", false, null], ["qwen3.5-0.8b", true, "chronos"]]);
    assert.equal(brains.modelPath(w.cat.brains[0]), path.join(w.chronos, "models", w.cat.brains[0].file), "start uses the reused file in place");
    assert.equal(brains.mmprojPath(w.cat.brains[0]), path.join(w.chronos, "models", w.cat.brains[0].mmproj));
    assert.equal(brains.engineDir, path.join(w.chronos, "bin", "llama"));
    assert.deepEqual(snapshot(w.chronos), before, "not a byte, a time or a mode changed in the full home");
    assert.deepEqual(fs.readdirSync(w.lite).sort(), [RECORD], "only the record was written, in Lite's home");
  } finally {
    for (const p of [path.join(w.chronos, "models")]) try { fs.chmodSync(p, 0o755); } catch {}
    w.done();
  }
});

test("a brains module given only a home reuses nothing, so no test reads the real full home", () => {
  const home = tmp("only");
  try {
    const brains = new Brains({ root: ROOT, home, bus: { emit() {} }, hasCard: false, readJunction: () => NaN });
    assert.equal(brains.reuseHome, null);
    assert.equal(brains.engineDir, path.join(home, "bin", "llama"));
    assert.ok(brains.list().every((r) => r.where === null && !r.present));
    assert.deepEqual(readRecord(home), { version: 1, engine: null, files: {} });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
