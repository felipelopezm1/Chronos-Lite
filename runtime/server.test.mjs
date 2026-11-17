import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Bus } from "./bus.mjs";
import { createQueue, createServer, DEFAULT_PORT, loadModules, serveStatic, shutdownRuntime } from "./server.mjs";

const root = path.resolve(import.meta.dirname, "..");

const T9 = "qwen3.5-9b";
const W4 = "qwen3.5-4b";
const O08 = "qwen3.5-0.8b";
const TIERS = {
  s: { titan: null, promethean: W4, offspring: O08, maxTasks: 1, tokens: 16000, seconds: 900, note: "no plan" },
  m: { titan: T9, promethean: W4, offspring: O08, maxTasks: 3, tokens: 64000, seconds: 2700, note: "plan and judge" },
};
const TIER = {
  s: { titan: null, promethean: W4, offspring: O08, judge: W4 },
  m: { titan: T9, promethean: W4, offspring: O08, judge: T9 },
};

/** stand-in brains with the catalogue's tiers, none loaded; `absent` names the brains that are not on disk */
function fakeBrains({ absent = [] } = {}) {
  const state = { [T9]: "idle", [W4]: "idle", [O08]: "idle" };
  const calls = [];
  return {
    calls,
    catalogue: { tiers: TIERS },
    list: () => [
      { id: T9, role: "talk", slot: "talk" },
      { id: W4, role: "promethean", slot: "promethean" },
      { id: O08, role: "offspring", slot: "offspring", device: "cpu" },
    ].map((b) => ({ ...b, status: state[b.id], present: !absent.includes(b.id) })),
    async start(id) {
      calls.push(["start", id]);
      state[id] = "ready";
      return { id, port: 7710, pid: 1 };
    },
    async stop(id) {
      calls.push(["stop", id]);
      state[id] = "idle";
      return { id };
    },
    async chat() {
      return { content: "", toolCalls: [] };
    },
    async stopAll() {
      calls.push(["stopAll"]);
      for (const id of Object.keys(state)) state[id] = "idle";
    },
  };
}

const fakeHardware = {
  readHardware: () => ({ vram: { totalMiB: 12288, usedMiB: 1000, freeMiB: 11288, card: "test" }, ram: { totalMiB: 30000, availableMiB: 20000 }, cpu: { threads: 16, load1: 0.5 }, at: Date.now() }),
  fits: () => ({ ok: true, why: "" }),
  watchHardware: () => () => {},
};

async function up({ absent = [], runner = null, ...opts } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-lite-srv-"));
  const bus = new Bus({ pingMs: 50 });
  const brains = fakeBrains({ absent });
  const app = createServer({ root, home, port: 0, bus, brains, hardware: fakeHardware, runner, ...opts });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const close = async () => {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { app, bus, brains, port, base, call, close, home };
}

test("Lite listens on 7778 by default, beside full Chronos on 7777", () => {
  assert.equal(DEFAULT_PORT, 7778);
});

test("/health says who this is: kind chronos, edition lite, the brains, the sizes s and m, the card lock, the queue", async () => {
  const { app, call, close } = await up();
  try {
    const { status, body } = await call("GET", "/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.kind, "chronos", "a caller written for Chronos hires it unchanged");
    assert.equal(body.edition, "lite");
    assert.equal(body.name, "Chronos Lite");
    assert.equal(body.builtOn, "built on Chronos");
    assert.equal(body.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
    assert.equal(body.port, app.server.address().port);
    assert.deepEqual(body.brains.map((b) => [b.id, b.status, b.present]), [[T9, "idle", true], [W4, "idle", true], [O08, "idle", true]]);
    assert.deepEqual(Object.keys(body.sizes), ["s", "m"]);
    assert.deepEqual(body.sizes.m.tier, TIER.m);
    assert.deepEqual(body.quests, { queued: 0, running: 0 });
    assert.ok("lock" in body.card && "mine" in body.card);
    assert.equal(typeof body.governor.runs, "boolean");
    assert.match(body.capabilities.hash, /^[0-9a-f]{12}$/);
    assert.equal(body.capabilities.url, "/capabilities");
  } finally {
    await close();
  }
});

test("/capabilities and /edition: the manifest and the white label, from lite/ and package.json", async () => {
  const { call, close } = await up();
  try {
    const caps = (await call("GET", "/capabilities")).body;
    assert.equal(caps.schema, "chronos-lite.capabilities/1");
    assert.equal(caps.edition, "lite");
    assert.deepEqual(Object.keys(caps.sizes), ["s", "m"]);
    assert.deepEqual(caps.cutSizes, { l: "m" });
    assert.equal(caps.tools.length, 8);
    assert.deepEqual(caps.caps, { brains: 3, sizes: ["s", "m"], cards: 1, turns: 25, splitDepth: 2, tools: 8 });
    assert.ok(caps.routes.some((r) => r.method === "POST" && r.path === "/quests"));
    assert.ok(caps.events.includes("quest.done"));
    assert.equal(caps.hash, (await call("GET", "/health")).body.capabilities.hash);
    const edition = (await call("GET", "/edition")).body;
    assert.deepEqual(Object.keys(edition).sort(), ["accent", "builtOn", "caps", "logo", "name", "shortName", "version"]);
    assert.equal(edition.name, "Chronos Lite");
    assert.equal(edition.shortName, "Lite");
    assert.equal(edition.builtOn, "built on Chronos");
    assert.equal(edition.caps.turns, 25);
  } finally {
    await close();
  }
});

test("/events replays an emitted event, then streams", async () => {
  const { bus, port, close } = await up();
  try {
    bus.emit("brain.ready", { id: "qwen3.5-9b" });
    const req = http.get({ host: "127.0.0.1", port, path: "/events" });
    const res = await new Promise((r) => req.on("response", r));
    assert.equal(res.headers["content-type"], "text/event-stream");
    const events = [];
    const got = new Promise((resolve) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = line.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
        }
        if (events.length >= 2) resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    bus.emit("log", { text: "live" });
    await got;
    assert.equal(events[0].type, "brain.ready");
    assert.equal(events[0].id, "qwen3.5-9b");
    assert.equal(events[1].type, "log");
    assert.ok(typeof events[1].t === "number");
    req.destroy();
  } finally {
    await close();
  }
});

test("/events?since=n replays only what came after n from the ring, with n as each block's id", async () => {
  const { bus, port, close } = await up();
  try {
    for (let i = 0; i < 5; i++) bus.emit("log", { text: `line ${i}` });
    const third = bus.history.find((e) => e.text === "line 2").n;
    const read = (headers = {}, q = `?since=${third}`) =>
      new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: `/events${q}`, headers }, (res) => {
          let buf = "";
          res.on("data", (c) => {
            buf += c;
            const blocks = buf.split("\n\n").filter((b) => b.includes("data: "));
            if (blocks.length >= 2) {
              req.destroy();
              resolve(blocks.map((b) => ({ id: Number(b.match(/^id: (\d+)/m)?.[1]), ev: JSON.parse(b.split("data: ")[1]) })));
            }
          });
        });
      });
    const got = await read();
    assert.deepEqual(got.map((b) => b.ev.text), ["line 3", "line 4"]);
    assert.deepEqual(got.map((b) => b.id), got.map((b) => b.ev.n));
    // a reconnecting browser says the same with Last-Event-ID
    const again = await read({ "last-event-id": String(third) }, "");
    assert.deepEqual(again.map((b) => b.ev.text), ["line 3", "line 4"]);
    // hardware readings are heard live but never kept, so they cannot push a quest's events out of the ring
    bus.emit("hardware.read", { at: 1 });
    assert.equal(bus.history.at(-1).type, "log");
  } finally {
    await close();
  }
});

test("POST /quests: the quest is stamped with its size and tier, and the bus hears quest.queued then quest.started", async () => {
  const { bus, call, close } = await up();
  try {
    const r = await call("POST", "/quests", { task: "Count the stars", by: "hephaestus", size: "s" });
    assert.equal(r.status, 202);
    assert.deepEqual([r.body.status, r.body.size], ["queued", "s"]);
    assert.deepEqual(r.body.tier, TIER.s);
    assert.equal(r.body.downgraded, undefined);
    const one = (await call("GET", `/quests/${r.body.id}`)).body;
    assert.deepEqual([one.task, one.by, one.size, one.asked], ["Count the stars", "hephaestus", "s", "s"]);
    const types = bus.history.filter((e) => e.id === r.body.id).map((e) => e.type);
    assert.deepEqual(types, ["quest.queued", "quest.started"]);
    // the size in the task's first line, stripped from the task
    const marked = (await call("POST", "/quests", { task: "[size:m] Chart the ocean" })).body;
    assert.equal(marked.size, "m");
    assert.equal((await call("GET", `/quests/${marked.id}`)).body.task, "Chart the ocean");
    // the list: newest first, no reports
    const list = (await call("GET", "/quests")).body;
    assert.deepEqual(list.quests.map((q) => q.id), [marked.id, r.body.id]);
    assert.deepEqual(list.counts, { queued: 2, running: 0 });
    assert.equal((await call("GET", "/quests/q-nope")).status, 404);
  } finally {
    await close();
  }
});

test("POST /quests with size l, large, or [size:l]: accepted as m, with downgraded and the note", async () => {
  const { bus, call, close } = await up();
  try {
    for (const body of [{ task: "Plan the move", size: "l" }, { task: "Plan the move", size: "Large" }, { task: "[size:l] Plan the move" }]) {
      const r = await call("POST", "/quests", body);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(r.body.size, "m");
      assert.deepEqual(r.body.tier, TIER.m);
      assert.deepEqual(r.body.downgraded, { from: "l", to: "m" });
      assert.equal(r.body.note, "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m");
      const one = (await call("GET", `/quests/${r.body.id}`)).body;
      assert.deepEqual([one.asked, one.size, one.task], ["l", "m", "Plan the move"]);
      assert.deepEqual(bus.history.find((e) => e.type === "quest.queued" && e.id === r.body.id).downgraded, { from: "l", to: "m" });
    }
  } finally {
    await close();
  }
});

test("POST /quests refuses no task, an unknown size, a bad budget, and a brain that is not in the catalogue", async () => {
  const { call, close } = await up();
  try {
    assert.equal((await call("POST", "/quests", {})).status, 400);
    assert.equal((await call("POST", "/quests", { task: "[size:s]" })).status, 400, "a marker alone is no task");
    const xl = await call("POST", "/quests", { task: "x", size: "xl" });
    assert.equal(xl.status, 400);
    assert.match(xl.body.error, /auto, s or m/);
    assert.equal((await call("POST", "/quests", { task: "x", budget: { tokens: -1 } })).status, 400);
    assert.equal((await call("POST", "/quests", { task: "x", brain: "qwen3.8-27b" })).status, 400);
    assert.equal((await call("POST", "/quests", { task: "x", budget: { tokens: 500 } })).status, 202);
  } finally {
    await close();
  }
});

test("an idempotency key makes a retry answer the same quest", async () => {
  const { call, close } = await up();
  try {
    const a = await call("POST", "/quests", { task: "Count the stars" }, { "idempotency-key": "k-1" });
    const b = await call("POST", "/quests", { task: "Count the stars" }, { "idempotency-key": "k-1" });
    assert.equal(b.status, 202);
    assert.equal(b.body.id, a.body.id);
    assert.equal(b.body.duplicate, true);
    const c = await call("POST", "/quests", { task: "Count the stars" }, { "idempotency-key": "k-2" });
    assert.notEqual(c.body.id, a.body.id);
    assert.equal((await call("GET", "/quests")).body.quests.length, 2);
  } finally {
    await close();
  }
});

test("a POST with a foreign Origin gets 403; a localhost page is let in; GET routes need no origin", async () => {
  const { call, close } = await up();
  try {
    const foreign = await call("POST", "/quests", { task: "x" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    const local = await call("POST", "/quests", { task: "x" }, { origin: "http://localhost:5173" });
    assert.equal(local.status, 202);
    assert.equal((await call("GET", "/health", undefined, { origin: "https://evil.example" })).status, 200);
  } finally {
    await close();
  }
});

test("the routes Lite cut answer 404", async () => {
  const { call, close } = await up();
  try {
    for (const [m, p] of [["GET", "/brains"], ["POST", "/chat"], ["GET", "/setup"], ["GET", "/chats"], ["POST", "/bridge/arrive"], ["POST", "/envoys"], ["GET", "/log"], ["GET", "/link"], ["POST", "/shutdown"], ["GET", "/media"]]) {
      assert.equal((await call(m, p, m === "POST" ? {} : undefined)).status, 404, `${m} ${p}`);
    }
  } finally {
    await close();
  }
});

test("the queue hands out the oldest queued quest, a runner starts with listen and closes with close, and old finished quests are forgotten", async () => {
  const bus = new Bus();
  const q = createQueue(bus, { keep: 3 });
  const a = q.add({ task: "a" });
  const b = q.add({ task: "b" });
  assert.equal(q.next().id, a.id);
  a.status = "done";
  assert.equal(q.next().id, b.id);
  q.add({ task: "c" });
  q.add({ task: "d" });
  assert.equal(q.get(a.id), null, "the oldest finished one goes first");
  assert.ok(q.get(b.id), "an unfinished one is never forgotten");
  let started = null;
  let closed = false;
  const { close } = await up({ runner: { start: (queue) => (started = queue), close: async () => (closed = true) } });
  assert.ok(started?.next);
  await close();
  assert.equal(closed, true);
});

test("POST /quests/:id/stop: a queued quest stops at once, a running one goes to the runner, an unknown is 404", async () => {
  const stopped = [];
  const { app, bus, call, close } = await up({ runner: { start() {}, stop: (id) => stopped.push(id) } });
  try {
    const q = (await call("POST", "/quests", { task: "x" })).body;
    const r = await call("POST", `/quests/${q.id}/stop`);
    assert.deepEqual(r.body, { id: q.id, status: "stopped" });
    assert.equal(bus.history.at(-1).type, "quest.done");
    const run = (await call("POST", "/quests", { task: "y" })).body;
    app.queue.get(run.id).status = "running";
    const s = await call("POST", `/quests/${run.id}/stop`);
    assert.equal(s.body.stopping, true);
    assert.deepEqual(stopped, [run.id]);
    assert.equal((await call("POST", "/quests/q-nope/stop")).status, 404);
  } finally {
    await close();
  }
});

test("a body over 1 MiB is refused with 413 and bad JSON with 400", async () => {
  const { base, close } = await up();
  try {
    const big = await fetch(`${base}/quests`, { method: "POST", body: "x".repeat(1024 * 1024 + 10) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    const bad = await fetch(`${base}/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test("the UI: static files under ui/, index.html at /, the right types, no way out of the folder, 404 with no ui/", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-lite-ui-"));
  const ui = path.join(dir, "ui");
  fs.mkdirSync(path.join(ui, "lib"), { recursive: true });
  fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>Lite</title>");
  fs.writeFileSync(path.join(ui, "lib", "app.js"), "export const x = 1;");
  fs.writeFileSync(path.join(ui, "style.css"), "body{}");
  fs.writeFileSync(path.join(dir, "secret.txt"), "not for the browser");
  const withUi = await up({ uiDir: ui });
  try {
    const index = await fetch(`${withUi.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /^text\/html/);
    assert.match(await index.text(), /<title>Lite<\/title>/);
    const js = await fetch(`${withUi.base}/lib/app.js`);
    assert.match(js.headers.get("content-type"), /^text\/javascript/);
    assert.match((await fetch(`${withUi.base}/style.css`)).headers.get("content-type"), /^text\/css/);
    assert.equal((await fetch(`${withUi.base}/nope.js`)).status, 404);
    // the API wins over a file of the same name
    assert.equal((await (await fetch(`${withUi.base}/health`)).json()).ok, true);
    // no way out: neither a raw nor an encoded ..
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/lib/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
      const r = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: withUi.port, path: p }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, text: t })); }));
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes("not for the browser"), p);
    }
    // a POST to a file is no route
    assert.equal((await fetch(`${withUi.base}/index.html`, { method: "POST" })).status, 404);
  } finally {
    await withUi.close();
  }
  const noUi = await up({ uiDir: path.join(dir, "missing") });
  try {
    const r = await fetch(`${noUi.base}/`);
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /no UI/);
  } finally {
    await noUi.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(serveStatic({ method: "GET" }, {}, null, "/"), false);
});

test("the real hardware and brains modules load into the server, the card lock read from the home it is given", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-lite-real-"));
  const bus = new Bus();
  // no lockHome: the lock stays inside the home given; only main() points it at the full Chronos home
  const { hardware, brains, missing } = await loadModules({ root, home, bus });
  assert.deepEqual(missing, []);
  assert.equal(brains.card.file, path.join(home, "run", "gpu.lock"));
  const app = createServer({ root, home, port: 0, bus, brains, hardware, missing });
  await app.listen();
  try {
    const health = await (await fetch(`${app.url()}/health`)).json();
    assert.equal(health.ok, true);
    assert.deepEqual(health.brains.map((b) => b.id).sort(), [O08, W4, T9].sort());
    assert.ok(health.brains.every((b) => b.status === "idle" && b.present === false), "a fresh home has no brains on disk");
    assert.equal(health.missing, undefined);
  } finally {
    await app.close();
    brains.dispose?.();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the heat watchdog stops every brain after two samples at 93 C junction, ignores a one-sample spike, re-arms under 85 C, and trips again", async () => {
  const { bus, brains, close } = await up();
  const reading = (junctionC) => ({ vram: { totalMiB: 12288, usedMiB: 9000, freeMiB: 3288, card: "test" }, ram: { totalMiB: 30000, availableMiB: 12000 }, cpu: { threads: 16, load1: 8 }, heat: { junctionC, edgeC: junctionC - 10, critC: 100, cpuC: 90, hot: junctionC >= 90 }, at: Date.now() });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  try {
    await brains.start("qwen3.5-9b");
    bus.emit("hardware.read", reading(88));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 0, "88 C is hot for new work, not a cutoff");
    bus.emit("hardware.read", reading(103));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 0, "one spike while a model loads is not a cutoff");
    bus.emit("hardware.read", reading(80));
    bus.emit("hardware.read", reading(94));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 0, "the run restarts after a cool sample");
    bus.emit("hardware.read", reading(94));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 1, "two hot samples in a row stop every brain");
    assert.equal(brains.list().find((b) => b.id === "qwen3.5-9b").status, "idle");
    const cut = bus.history.find((e) => e.type === "heat.cutoff");
    assert.equal(cut.junctionC, 94);
    assert.match(cut.text, /every brain is stopped/);
    bus.emit("hardware.read", reading(91));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 1, "still tripped: no second stop while it cools");
    bus.emit("hardware.read", reading(80));
    await settle();
    assert.ok(bus.history.some((e) => e.type === "heat.clear" && e.junctionC === 80), "re-armed under 85 C");
    bus.emit("hardware.read", reading(96));
    bus.emit("hardware.read", reading(96));
    await settle();
    assert.equal(brains.calls.filter((c) => c[0] === "stopAll").length, 2, "trips again on the next sustained climb");
    bus.emit("hardware.read", { vram: {}, ram: {}, cpu: {}, at: 0 });
    await settle();
  } finally {
    await close();
  }
});

test("shutdown closes the app before stopping the brains, then exits 0", async () => {
  const order = [];
  await shutdownRuntime({ app: { bus: { emit() {} }, close: async () => order.push("close") }, brains: { stopAll: async () => order.push("brains") }, beacon: { stop: () => order.push("beacon") }, exit: (code) => order.push(`exit ${code}`), log: null });
  assert.deepEqual(order, ["beacon", "close", "brains", "exit 0"]);
});

test("the real runtime, started as a program on a throwaway home: 7778's twin on a free port, its beacon says chronos-lite, SIGTERM stops it and removes the beacon", { timeout: 60_000, skip: process.platform === "win32" && "SIGTERM is a kill on Windows" }, async () => {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-lite-run-"));
  const home = path.join(dir, "home");
  const full = path.join(dir, "full-chronos");
  const workdir = path.join(dir, "work", "deep");
  const estate = path.join(dir, "estate");
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const env = { ...process.env, CHRONOS_LITE_HOME: home, CHRONOS_HOME: full, CHRONOS_LITE_WORKDIR: workdir, CHRONOS_LITE_PORT: String(port), HEPHAESTUS_ESTATE_DIR: estate };
  const child = spawn(process.execPath, [path.join(root, "runtime", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let health = null;
    for (let i = 0; i < 400 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.ok(health?.ok, `the runtime came up (${out.slice(-400)})`);
    assert.equal(health.edition, "lite");
    assert.equal(health.cwd, workdir);
    assert.equal(health.code, root);
    assert.ok(health.brains.every((b) => b.status === "idle"), "no brain was started");
    assert.ok(fs.statSync(workdir).isDirectory(), "the work folder was made");
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/edition`)).json()).name, "Chronos Lite");
    const beacon = JSON.parse(fs.readFileSync(path.join(estate, "runtimes", `${port}.json`), "utf8"));
    assert.equal(beacon.kind, "chronos-lite");
    assert.equal(beacon.edition, "lite");
    child.kill("SIGTERM");
    const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    assert.deepEqual(end, { code: 0, signal: null });
    assert.equal(fs.existsSync(path.join(estate, "runtimes", `${port}.json`)), false, "its beacon is gone");
    assert.match(out, /chronos-lite stopping \(SIGTERM\)/);
    assert.equal(fs.existsSync(path.join(full, "run", "gpu.lock")), false, "no brain started, so the card was never taken");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/health says stale when the card lock's holder and its engine are gone, and not while the holder lives", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lite-stale-"));
  // a pid that was alive a moment ago and is not now, as a full Chronos killed without giving the card back
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  const lockFile = path.join(home, "run", "gpu.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const bare = createServer({ root, home, port: 0, bus: new Bus(), brains: { list: () => [], stopAll: async () => {} }, hardware: { readHardware: () => null }, setup: null });
  const port = await bare.listen();
  const card = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).card;
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: gone, port: 7777, brain: "qwen3.5-4b", host: os.hostname(), what: "server.mjs", id: `${gone}-dead`, engines: [gone] }));
    const stale = await card();
    assert.equal(stale.lock.pid, gone);
    assert.equal(stale.mine, false);
    assert.equal(stale.stale, true);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 7777, brain: "qwen3.5-4b", host: os.hostname(), id: "live", engines: [] }));
    assert.equal((await card()).stale, false, "a live holder is never called stale");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: gone, port: 7777, host: "elsewhere", id: "far", engines: [] }));
    assert.equal((await card()).stale, false, "another host's lock is never judged from here");
  } finally {
    await bare.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
