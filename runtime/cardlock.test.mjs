import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { CARD_WAIT_MS, cardLockPath, cardWaitMs, createCardLock, describeHolder, momentary, pidAlive, readCardLock } from "./cardlock.mjs";
import { Brains } from "./brains.mjs";
import { createServer } from "./server.mjs";
import { Bus } from "./bus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** stand-in pids: the test says which are alive */
function pids(...live) {
  const set = new Set(live);
  return { set, alive: (pid) => set.has(pid) };
}

const tempHome = () => mkdtempSync(path.join(os.tmpdir(), "chronos-card-"));

test("pidAlive: this process is alive, a pid that is not there is not, nonsense is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(pidAlive("12"), false);
  assert.equal(pidAlive(2 ** 22 + 12345), false, "beyond pid_max");
});

test("CHRONOS_GPU_WAIT_MS: a number wins (0 too), anything else is the 10-minute default", () => {
  assert.equal(CARD_WAIT_MS, 600_000);
  assert.equal(cardWaitMs({}), 600_000);
  assert.equal(cardWaitMs({ CHRONOS_GPU_WAIT_MS: "5000" }), 5000);
  assert.equal(cardWaitMs({ CHRONOS_GPU_WAIT_MS: "0" }), 0);
  assert.equal(cardWaitMs({ CHRONOS_GPU_WAIT_MS: "soon" }), 600_000);
  assert.equal(cardWaitMs({ CHRONOS_GPU_WAIT_MS: "" }), 600_000);
});

test("a second holder is refused while the first's pid is alive, and gets the card once the first releases", async () => {
  const home = tempHome();
  try {
    const p = pids(1001, 1002);
    const first = createCardLock({ home, pid: 1001, port: 7778, alive: p.alive, waitMs: 2000, pollMs: 20 });
    const second = createCardLock({ home, pid: 1002, port: 7777, alive: p.alive, waitMs: 2000, pollMs: 20 });
    assert.equal(readCardLock(home), null, "the card starts free");

    const took = first.tryTake("qwen3.8-27b");
    assert.equal(took.ok, true);
    const lock = readCardLock(home);
    assert.deepEqual({ pid: lock.pid, port: lock.port, brain: lock.brain, host: lock.host }, { pid: 1001, port: 7778, brain: "qwen3.8-27b", host: os.hostname() });
    assert.ok(!Number.isNaN(Date.parse(lock.since)));
    assert.equal(first.held, true);
    assert.deepEqual(first.status(), { lock, mine: true });
    assert.deepEqual(second.status(), { lock, mine: false });
    assert.equal(first.tryTake("qwen3.5-4b").ok, true, "a holder may put more of its own brains on the card");

    const refused = second.tryTake("qwen3.5-9b");
    assert.equal(refused.ok, false);
    assert.equal(refused.holder.pid, 1001);
    assert.equal(readCardLock(home).pid, 1001, "the refusal changed nothing");
    assert.equal(second.release(), false, "a process that does not hold the card cannot remove the lock");
    assert.equal(readCardLock(home).pid, 1001);

    // the second waits, then gets the card the moment the first gives it back
    const waits = [];
    const getting = second.acquire("qwen3.5-9b", { onWait: (holder, text) => waits.push({ holder, text }) });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(waits.length, 1, "one word that it waits, not one per look");
    assert.equal(waits[0].text, "the card is in use by qwen3.8-27b of the Chronos on port 7778 (pid 1001); waiting");
    assert.equal(first.release(), true);
    const got = await getting;
    assert.equal(got.ok, true);
    assert.equal(readCardLock(home).pid, 1002);
    assert.equal(second.status().mine, true);
    assert.equal(second.release(), true);
    assert.equal(readCardLock(home), null);
    assert.deepEqual(readdirSync(path.dirname(cardLockPath(home))), [], "no temporary file is left behind");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lock whose pid is dead is taken over; one whose engine still runs is not", async () => {
  const home = tempHome();
  try {
    const p = pids(2002);
    mkdirSync(path.dirname(cardLockPath(home)), { recursive: true });
    // a runtime that died without giving the card back
    writeFileSync(cardLockPath(home), JSON.stringify({ pid: 2001, port: 7779, brain: "qwen3.5-9b", since: new Date().toISOString(), host: os.hostname(), id: "2001-dead", engines: [] }));
    const said = [];
    const mine = createCardLock({ home, pid: 2002, alive: p.alive, waitMs: 500, pollMs: 20 });
    const got = await mine.acquire("qwen3.5-4b", { onTakeover: (stale, text) => said.push(text), onWait: () => assert.fail("a stale lock is never waited for") });
    assert.equal(got.ok, true);
    assert.equal(got.tookOver.pid, 2001);
    assert.match(said[0], /the card lock of qwen3\.5-9b of the Chronos on port 7779 \(pid 2001\) was stale/);
    assert.equal(readCardLock(home).pid, 2002);
    mine.release();

    // the runtime died (SIGKILL) but its llama-server still runs on the card: the lock is alive through it
    p.set.add(3003);
    writeFileSync(cardLockPath(home), JSON.stringify({ pid: 2001, port: 7779, brain: "qwen3.5-9b", host: os.hostname(), id: "2001-orphan", engines: [3003] }));
    const blocked = mine.tryTake("qwen3.5-4b");
    assert.equal(blocked.ok, false);
    assert.match(describeHolder(blocked.holder, { alive: p.alive }), /that process is gone but its engine \(pid 3003\) still runs on the card/);
    p.set.delete(3003);
    assert.equal(mine.tryTake("qwen3.5-4b").ok, true, "and stale once the engine is gone too");
    mine.release();

    // a lock that cannot be read is no holder
    writeFileSync(cardLockPath(home), "{half");
    assert.equal(mine.tryTake("qwen3.5-4b").ok, true);
    mine.release();

    // a lock from another host (a home shared over the network) is never judged from here
    writeFileSync(cardLockPath(home), JSON.stringify({ pid: 2001, host: "elsewhere", id: "far" }));
    assert.equal(mine.tryTake("qwen3.5-4b").ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** the real fs, with some calls failing the way Windows fails them while another process has the file open */
function flakyFs(fails) {
  const left = { ...fails };
  const busy = (name, file) => {
    const rule = left[name];
    if (!rule || (rule.file && path.basename(file) !== rule.file) || rule.times === 0) return;
    rule.times -= 1;
    throw Object.assign(new Error(`${rule.code}: operation not permitted, ${name} '${file}'`), { code: rule.code });
  };
  return {
    ...fs,
    readFileSync: (f, ...a) => (busy("readFileSync", f), fs.readFileSync(f, ...a)),
    linkSync: (a, b) => (busy("linkSync", b), fs.linkSync(a, b)),
    renameSync: (a, b) => (busy("renameSync", a), fs.renameSync(a, b)),
    unlinkSync: (f) => (busy("unlinkSync", f), fs.unlinkSync(f)),
    left,
  };
}

test("momentary: EPERM, EACCES and EBUSY are a look-again on Windows only; anywhere else they are failures", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    assert.equal(momentary({ code }, "win32"), true, code);
    assert.equal(momentary({ code }, "linux"), false, code);
    assert.equal(momentary({ code }, "darwin"), false, code);
  }
  assert.equal(momentary({ code: "ENOENT" }, "win32"), false);
  assert.equal(momentary(null, "win32"), false);
});

test("on Windows a lock file in another process's hands is waited on, never taken over, and the lock still comes and goes", async () => {
  const home = tempHome();
  const pauses = [];
  try {
    const p = pids(4001, 4002);
    // the holder deletes the lock while a reader still has it open: creating it again answers EPERM for a moment
    const fsA = flakyFs({ linkSync: { code: "EPERM", times: 1, file: "gpu.lock" } });
    const a = createCardLock({ home, pid: 4001, alive: p.alive, platform: "win32", fsApi: fsA, pause: (ms) => pauses.push(ms), waitMs: 500, pollMs: 10 });
    assert.equal(a.tryTake("qwen3.5-9b").ok, true, "the EPERM was a look-again");
    assert.equal(fsA.left.linkSync.times, 0);

    // the lock reads EBUSY to another: it is in someone's hands, so it is a live holder, not a stale one
    const fsB = flakyFs({ readFileSync: { code: "EBUSY", times: 100, file: "gpu.lock" } });
    const b = createCardLock({ home, pid: 4002, alive: () => false, platform: "win32", fsApi: fsB, pause: () => {}, waitMs: 0, pollMs: 10 });
    const refused = b.tryTake("qwen3.5-4b");
    assert.equal(refused.ok, false);
    assert.equal(refused.holder.busy, true);
    assert.equal(describeHolder(refused.holder), "a lock file another process has open this moment");
    assert.equal(readCardLock(home).pid, 4001, "nothing moved it aside");

    // replacing and deleting a lock someone is reading: each tried again after a short pause
    fsA.left.renameSync = { code: "EACCES", times: 2, file: null };
    a.setEngines([{ id: "qwen3.5-9b", pid: 5005 }]);
    assert.deepEqual(readCardLock(home).engines, [5005]);
    assert.equal(fsA.left.renameSync.times, 0);
    assert.ok(!readdirSync(path.dirname(cardLockPath(home))).some((f) => f.endsWith(".tmp")), "no temp file left");
    fsA.left.unlinkSync = { code: "EPERM", times: 2, file: "gpu.lock" };
    assert.equal(a.release(), true);
    assert.equal(readCardLock(home), null, "the card is free");
    assert.ok(pauses.length >= 4 && pauses.every((ms) => ms === 20), "four short pauses, no more");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on Linux and macOS the same EPERM is a real failure and says so", () => {
  const home = tempHome();
  try {
    for (const platform of ["linux", "darwin"]) {
      const lock = createCardLock({ home, pid: 4003, alive: () => true, platform, fsApi: flakyFs({ linkSync: { code: "EPERM", times: 1, file: "gpu.lock" } }), pause: () => assert.fail("no pause off Windows") });
      assert.throws(() => lock.tryTake("qwen3.5-4b"), (err) => err.code === "EPERM");
      assert.equal(readCardLock(home), null);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the wait ends with a clear error after the time it was given, and a cancelled wait ends at once", async () => {
  const home = tempHome();
  try {
    const p = pids(4001, 4002);
    const holder = createCardLock({ home, pid: 4001, port: 7778, alive: p.alive });
    holder.tryTake("qwen3.8-27b");
    const waiter = createCardLock({ home, pid: 4002, port: 7777, alive: p.alive, waitMs: 250, pollMs: 30 });
    const t = Date.now();
    await assert.rejects(waiter.acquire("qwen3.5-9b"), (err) => {
      assert.equal(err.code, "CARD_BUSY");
      assert.equal(err.holder.pid, 4001);
      assert.match(err.message, /^the card is in use by qwen3\.8-27b of the Chronos on port 7778 \(pid 4001\); qwen3\.5-9b waited 0 s and did not start \(it does not move to the CPU on its own/);
      return true;
    });
    assert.ok(Date.now() - t >= 240 && Date.now() - t < 2000, `it waited the time given (${Date.now() - t} ms)`);
    assert.equal(readCardLock(home).pid, 4001, "the holder keeps the card");

    let stop = false;
    setTimeout(() => (stop = true), 60);
    const long = createCardLock({ home, pid: 4002, alive: p.alive, waitMs: 60_000, pollMs: 20 });
    await assert.rejects(long.acquire("qwen3.5-9b", { cancelled: () => stop }), (err) => err.code === "CARD_CANCELLED");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- through Brains, with a stand-in engine

/** stands in for llama-server: answers /health with ok on its --port; it loads no model and touches no card */
const FAKE_ENGINE = `#!${process.execPath}
const http = require("node:http");
const args = process.argv.slice(2);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
}).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const GPU_ID = "qwen3.5-4b";
const CPU_ID = "qwen3.5-0.8b";

/** a temp home with the stand-in engine and the two brains' files; Brains over it that never touches the real card */
async function stage({ port = 7790, alive, wait = 10_000 } = {}) {
  const home = tempHome();
  const events = [];
  const bus = { emit: (type, data) => events.push({ type, data }) };
  const gpuCalls = [];
  const brains = new Brains({
    root: ROOT, home, bus, port,
    readJunction: () => NaN, hasCard: true, listDevices: () => "", vramTotalMiB: () => 0,
    gpu: async (m) => { gpuCalls.push(m); return { ok: true, out: "" }; },
    cardWait: wait, cardPollMs: 25, ...(alive ? { alive } : {}),
  });
  brains.catalogue.engine = { ...brains.catalogue.engine, device: "auto" };
  delete brains.catalogue.engine.gpuLimit;
  mkdirSync(path.join(home, "models"), { recursive: true });
  mkdirSync(path.join(home, "bin", "llama"), { recursive: true });
  writeFileSync(brains.engine, FAKE_ENGINE);
  chmodSync(brains.engine, 0o755);
  for (const id of [GPU_ID, CPU_ID]) {
    const b = brains.brainOf(id);
    b.port = await freePort();
    b.vramMiB = 0;
    b.ramMiB = 0; // asks for no RAM: on a small runner (macOS has 7 GB) what is free above the 2 GiB kept for the owner can be nothing
    writeFileSync(path.join(home, "models", b.file), "not a real gguf");
  }
  brains.brainOf(GPU_ID).device = "gpu";
  brains.brainOf(CPU_ID).device = "cpu";
  const cleanup = async () => {
    await brains.stopAll().catch(() => {});
    brains.dispose();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, brains, events, gpuCalls, cleanup };
}

const unixOnly = { skip: process.platform === "win32" ? "the stand-in engine is a script with a #! line" : (process.env.CHRONOS_DEVICE === "cpu" && "CHRONOS_DEVICE=cpu puts every brain on the CPU"), timeout: 60_000 };

test("Brains: a GPU brain takes the lock and gives it back when the last GPU brain stops; CPU brains never touch it", unixOnly, async () => {
  const t = await stage({ port: 7790 });
  try {
    await t.brains.start(CPU_ID);
    assert.equal(readCardLock(t.home), null, "a CPU brain leaves the card lock alone");
    assert.equal(existsSync(path.join(t.home, "run")), false, "it does not even make the folder");

    const started = await t.brains.start(GPU_ID);
    const lock = readCardLock(t.home);
    assert.deepEqual({ pid: lock.pid, port: lock.port, brain: lock.brain, engines: lock.engines }, { pid: process.pid, port: 7790, brain: GPU_ID, engines: [started.pid] });
    assert.deepEqual(t.brains.cardStatus(), { lock, mine: true });

    await t.brains.stop(CPU_ID);
    assert.equal(readCardLock(t.home)?.pid, process.pid, "stopping a CPU brain keeps the card");
    await t.brains.stop(GPU_ID);
    assert.equal(readCardLock(t.home), null, "the last GPU brain stopped: the card is free");
    assert.ok(t.events.some((e) => e.type === "log" && /the card is free/.test(e.data.text)));
    assert.deepEqual(t.brains.cardStatus(), { lock: null, mine: false });
  } finally {
    await t.cleanup();
  }
});

test("Brains: the lock goes when the brain's process exits on its own, and the brain says it failed", unixOnly, async () => {
  const t = await stage({ port: 7791 });
  try {
    const started = await t.brains.start(GPU_ID);
    assert.equal(readCardLock(t.home)?.pid, process.pid);
    process.kill(started.pid, "SIGKILL");
    for (let i = 0; i < 100 && readCardLock(t.home); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(readCardLock(t.home), null, "the engine is gone: so is the lock");
    const row = t.brains.list().find((b) => b.id === GPU_ID);
    assert.equal(row.status, "failed");
    assert.equal(row.pid, null);
    assert.ok(t.events.some((e) => e.type === "brain.failed" && e.data.id === GPU_ID && /exited \(SIGKILL\) while it was ready/.test(e.data.why)));
  } finally {
    await t.cleanup();
  }
});

test("Brains: a GPU start waits (status waiting, one brain.waiting) while another Chronos holds the card, then loads once it is free", unixOnly, async () => {
  const t = await stage({ port: 7792 });
  const other = createCardLock({ home: t.home, pid: process.pid, port: 7778, what: "server.mjs" });
  try {
    other.tryTake("qwen3.8-27b");
    const starting = t.brains.start(GPU_ID);
    for (let i = 0; i < 100 && t.brains.list().find((b) => b.id === GPU_ID).status !== "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
    const row = t.brains.list().find((b) => b.id === GPU_ID);
    assert.equal(row.status, "waiting");
    assert.equal(row.waitingFor.port, 7778);
    assert.equal(row.why, `the card is in use by qwen3.8-27b of the Chronos on port 7778 (pid ${process.pid}); waiting`);
    await new Promise((r) => setTimeout(r, 120));
    const waited = t.events.filter((e) => e.type === "brain.waiting");
    assert.equal(waited.length, 1);
    assert.equal(waited[0].data.text, row.why);
    await assert.rejects(t.brains.start(GPU_ID), /already waiting for the card/);
    // the CPU brain is not held up by the card
    await t.brains.start(CPU_ID);
    assert.equal(t.brains.state.get(GPU_ID).child, null, "nothing was spawned while it waited");

    other.release();
    const started = await starting;
    assert.ok(started.pid > 0);
    assert.equal(t.brains.list().find((b) => b.id === GPU_ID).status, "ready");
    assert.equal(readCardLock(t.home).port, 7792, "the card is this runtime's now");
  } finally {
    other.release();
    await t.cleanup();
  }
});

test("Brains: a wait that runs out fails the start with the holder named and never falls back to the CPU; stop calls a wait off", unixOnly, async () => {
  const t = await stage({ port: 7793, wait: 200 });
  const other = createCardLock({ home: t.home, pid: process.pid, port: 7778 });
  try {
    other.tryTake("qwen3.8-27b");
    await assert.rejects(t.brains.start(GPU_ID), /the card is in use by qwen3\.8-27b of the Chronos on port 7778 .*did not start \(it does not move to the CPU on its own/);
    const s = t.brains.state.get(GPU_ID);
    assert.equal(s.status, "failed");
    assert.equal(s.child, null, "no engine was started, on the card or the CPU");
    assert.ok(t.events.some((e) => e.type === "brain.failed" && e.data.id === GPU_ID && /card is in use/.test(e.data.why)));
    assert.equal(readCardLock(t.home).port, 7778, "the other keeps its card");

    // a long wait called off by a stop
    t.brains.card = createCardLock({ home: t.home, port: 7793, waitMs: 60_000, pollMs: 20 });
    const starting = t.brains.start(GPU_ID);
    for (let i = 0; i < 100 && s.status !== "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.status, "waiting");
    await t.brains.stop(GPU_ID);
    await assert.rejects(starting, /stopped while it waited for the card/);
    assert.equal(s.status, "idle");
    assert.equal(readCardLock(t.home).port, 7778);
  } finally {
    other.release();
    await t.cleanup();
  }
});

test("Brains: a stale lock of a dead runtime is taken over at the start, and dispose and process exit give the card back", unixOnly, async () => {
  const p = pids(process.pid);
  const t = await stage({ port: 7794, alive: p.alive });
  try {
    mkdirSync(path.join(t.home, "run"), { recursive: true });
    writeFileSync(cardLockPath(t.home), JSON.stringify({ pid: 999_999, port: 7777, brain: "qwen3.5-9b", host: os.hostname(), id: "dead", engines: [] }));
    const started = await t.brains.start(GPU_ID);
    assert.equal(readCardLock(t.home).pid, process.pid);
    assert.ok(t.events.some((e) => e.type === "log" && /was stale \(nothing of it runs\)/.test(e.data.text)));
    p.set.add(started.pid);

    // the process exit hook (the runtime's last word) gives the card back with its engines
    t.brains._onExit();
    assert.equal(readCardLock(t.home), null);
    await t.brains.stopAll();

    // dispose with nothing on the card: free; dispose with a brain still up keeps it (the brain is on the card)
    await t.brains.start(GPU_ID);
    t.brains.dispose();
    assert.equal(readCardLock(t.home)?.pid, process.pid, "a brain still runs: the card stays held");
    await t.brains.stop(GPU_ID);
    assert.equal(readCardLock(t.home), null);
  } finally {
    await t.cleanup();
  }
});

test("GET /health carries card {lock, mine}", async () => {
  const home = tempHome();
  const p = pids(5001);
  const brains = new Brains({ root: ROOT, home, bus: { emit() {} }, readJunction: () => NaN, hasCard: true, port: 7795 });
  const app = createServer({ root: ROOT, home, port: 0, bus: new Bus(), brains, hardware: { readHardware: () => null }, setup: null });
  const port = await app.listen();
  const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).card;
  try {
    assert.deepEqual(await health(), { lock: null, mine: false });
    const other = createCardLock({ home, pid: 5001, port: 7778, alive: p.alive });
    other.tryTake("qwen3.8-27b");
    const seen = await health();
    assert.equal(seen.mine, false);
    assert.deepEqual({ pid: seen.lock.pid, port: seen.lock.port, brain: seen.lock.brain }, { pid: 5001, port: 7778, brain: "qwen3.8-27b" });
    other.release();
    brains.card.tryTake(GPU_ID);
    const ours = await health();
    assert.equal(ours.mine, true);
    assert.equal(ours.lock.port, 7795);
    brains.card.release();
  } finally {
    await app.close();
    brains.dispose();
    rmSync(home, { recursive: true, force: true });
  }

  // a server over stand-in brains reads the file itself
  const home2 = tempHome();
  const bare = createServer({ root: ROOT, home: home2, port: 0, bus: new Bus(), brains: { list: () => [], stopAll: async () => {} }, hardware: { readHardware: () => null }, setup: null });
  const port2 = await bare.listen();
  try {
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port2}/health`)).json()).card, { lock: null, mine: false });
    createCardLock({ home: home2, pid: 5001, port: 7778, alive: p.alive }).tryTake("qwen3.8-27b");
    const card = (await (await fetch(`http://127.0.0.1:${port2}/health`)).json()).card;
    assert.equal(card.lock.port, 7778);
    assert.equal(card.mine, false);
  } finally {
    await bare.close();
    rmSync(home2, { recursive: true, force: true });
  }
});
