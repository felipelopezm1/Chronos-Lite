import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Bus } from "./bus.mjs";
import { createRunner } from "./quests.mjs";
import { createQueue, createServer, loadModules, shutdownRuntime } from "./server.mjs";

const root = path.resolve(import.meta.dirname, "..");
const has = (f) => fs.existsSync(path.join(import.meta.dirname, f));

/** stand-in brains: two in the catalogue, one in the talk slot, none loaded */
function fakeBrains() {
  const state = { "qwen3.5-9b": "idle", "qwen3.5-4b": "idle" };
  const calls = [];
  return {
    calls,
    list: () => [
      { id: "qwen3.5-9b", role: "talk", status: state["qwen3.5-9b"], slot: "talk" },
      { id: "qwen3.5-4b", role: "promethean", status: state["qwen3.5-4b"], slot: "promethean" },
    ],
    async start(id) {
      calls.push(["start", id]);
      if (!(id in state)) throw new Error(`No brain "${id}" in the catalogue.`);
      state[id] = "ready";
      return { id, port: 7610, pid: 1 };
    },
    async stop(id) {
      calls.push(["stop", id]);
      state[id] = "idle";
      return { id };
    },
    async switchSlot(slot, id) {
      calls.push(["switch", slot, id]);
      throw new Error(`Cannot switch "${slot}" to "${id}": 100000 MiB asked, 12000 MiB free.`);
    },
    async chat(id, messages, opts) {
      calls.push(["chat", id, messages, opts]);
      return { content: `echo: ${messages.at(-1).content}`, toolCalls: [], usage: { prompt: 3, completion: 2 }, tokensPerSecond: 42 };
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

async function up() {
  const bus = new Bus({ pingMs: 50 });
  const brains = fakeBrains();
  const app = createServer({ root, port: 0, bus, brains, hardware: fakeHardware });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, bus, brains, port, base, call };
}

test("/health answers with who this is, the brains, the hardware and the queue", async () => {
  const { app, call } = await up();
  try {
    const { status, body } = await call("GET", "/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.kind, "chronos");
    assert.equal(body.name, "Chronos");
    assert.equal(body.cwd, root);
    assert.equal(body.port, app.server.address().port);
    assert.ok(body.commit === null || /^[0-9a-f]{7}$/.test(body.commit));
    assert.deepEqual(body.brains, [
      { id: "qwen3.5-9b", role: "talk", status: "idle", slot: "talk" },
      { id: "qwen3.5-4b", role: "promethean", status: "idle", slot: "promethean" },
    ]);
    assert.equal(body.hardware.vram.totalMiB, 12288);
    assert.deepEqual(body.quests, { queued: 0, running: 0 });
    assert.equal((await call("GET", "/hardware")).body.cpu.threads, 16);
    assert.equal((await call("GET", "/brains")).body.length, 2);
    assert.equal((await call("GET", "/nope")).status, 404);
  } finally {
    await app.close();
  }
});

test("/events replays an emitted event, then streams", async () => {
  const { app, bus, port } = await up();
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
    await app.close();
  }
});

test("/quests round-trip: enqueue, list, read one, and the bus hears quest.started", async () => {
  const { app, bus, call } = await up();
  try {
    const heard = [];
    bus.on("quest.started", (e) => heard.push(e));
    assert.equal((await call("POST", "/quests", {})).status, 400);
    const { status, body } = await call("POST", "/quests", { task: "count the stars", by: "felipe" });
    assert.equal(status, 202);
    assert.match(body.id, /^q-[0-9a-z]+$/);
    assert.equal(body.status, "queued");
    const list = (await call("GET", "/quests")).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].task, "count the stars");
    assert.equal(list[0].by, "felipe");
    const one = await call("GET", `/quests/${body.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.id, body.id);
    assert.equal((await call("GET", "/quests/q-nothing")).status, 404);
    assert.equal(heard.length, 1);
    assert.equal(heard[0].id, body.id);
    assert.deepEqual((await call("GET", "/health")).body.quests, { queued: 1, running: 0 });
  } finally {
    await app.close();
  }
});

test("/bridge/arrive refuses a bad envoy and takes a good one, never showing its key", async () => {
  const { app, call } = await up();
  try {
    const good = { id: "envoy-abc123-def456", key: "0123456789abcdef0123456789abcdef", from: { id: "hephaestus", name: "Hephaestus", port: 7331 }, ask: "what time is it", by: "felipe" };
    assert.equal((await call("POST", "/bridge/arrive", { ...good, key: "short" })).status, 400);
    assert.equal((await call("POST", "/bridge/arrive", { ...good, id: "not-an-envoy" })).status, 400);
    assert.equal((await call("POST", "/bridge/arrive", { ...good, from: { id: "x", name: "y" } })).status, 400);
    assert.equal((await call("POST", "/bridge/arrive", { ...good, ask: "  " })).status, 400);
    const { status, body } = await call("POST", "/bridge/arrive", good);
    assert.equal(status, 202);
    assert.equal(body.ok, true);
    const q = (await call("GET", `/quests/${body.quest}`)).body;
    assert.equal(q.tag, "envoy");
    assert.equal(q.task, "what time is it");
    assert.deepEqual(q.envoy, { id: good.id, from: good.from });
    assert.ok(!JSON.stringify(q).includes(good.key), "the key stays private");
    assert.equal(app.queue.keys.get(body.quest), good.key);
    // the same envoy twice is the same quest
    const again = await call("POST", "/bridge/arrive", good);
    assert.equal(again.body.quest, body.quest);
    assert.equal((await call("GET", "/quests")).body.length, 1);
  } finally {
    await app.close();
  }
});

test("a POST with a foreign Origin gets 403; a localhost page is let in", async () => {
  const { app, call } = await up();
  try {
    const bad = await call("POST", "/quests", { task: "x" }, { origin: "https://evil.example" });
    assert.equal(bad.status, 403);
    const ok = await call("POST", "/quests", { task: "x" }, { origin: "http://localhost:5173" });
    assert.equal(ok.status, 202);
    assert.equal((await call("GET", "/quests")).body.length, 1);
  } finally {
    await app.close();
  }
});

test("the brains routes: start, stop, a refused switch is 409, and /chat starts the brain first", async () => {
  const { app, brains, call } = await up();
  try {
    assert.equal((await call("POST", "/brains/qwen3.5-9b/start")).status, 200);
    assert.equal((await call("POST", "/brains/nope/start")).status, 409);
    const sw = await call("POST", "/brains/switch", { slot: "talk", id: "gemma-4-12b" });
    assert.equal(sw.status, 409);
    assert.match(sw.body.error, /Cannot switch/);
    assert.equal((await call("POST", "/brains/switch", { slot: "talk" })).status, 400);
    assert.equal((await call("POST", "/brains/qwen3.5-9b/stop")).status, 200);

    assert.equal((await call("POST", "/chat", {})).status, 400);
    const chat = await call("POST", "/chat", { messages: [{ role: "user", content: "hello" }], thinking: true, maxTokens: 64 });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.brain, "qwen3.5-9b");
    assert.equal(chat.body.content, "echo: hello");
    assert.equal(chat.body.tokensPerSecond, 42);
    const started = brains.calls.filter((c) => c[0] === "start").map((c) => c[1]);
    assert.deepEqual(started, ["qwen3.5-9b", "nope", "qwen3.5-9b"], "the idle talk brain was started before the chat");
    const last = brains.calls.at(-1);
    assert.deepEqual(last[3], { thinking: true, maxTokens: 64 });
    // the brain is ready now: a second chat starts nothing
    await call("POST", "/chat", { slot: "talk", messages: [{ role: "user", content: "again" }] });
    assert.equal(brains.calls.filter((c) => c[0] === "start").length, 3);
    assert.equal((await call("POST", "/chat", { brain: "nope", messages: [{ role: "user", content: "x" }] })).status, 404);
  } finally {
    await app.close();
  }
});

test("alternates are visible, skipped by automatic pickers, and usable only when named", async () => {
  const altId = "qwen3.5-0.8b-colibri";
  const state = { "qwen3.5-9b": "idle", [altId]: "idle", "qwen3.5-4b": "idle" };
  const calls = [];
  const brains = {
    list: () => [
      { id: "qwen3.5-9b", role: "talk", status: state["qwen3.5-9b"], slot: null },
      { id: "qwen3.5-4b", role: "promethean", status: state["qwen3.5-4b"], slot: "promethean" },
      { id: altId, role: "talk", status: state[altId], slot: "talk", alternate: true, engine: "colibri", present: true },
    ],
    async start(id) {
      calls.push(["start", id]);
      if (!(id in state)) throw new Error(`No brain "${id}" in the catalogue.`);
      state[id] = "ready";
      return { id, port: 1, pid: 1 };
    },
    async stop(id) {
      calls.push(["stop", id]);
      state[id] = "idle";
      return { id };
    },
    async switchSlot(slot, id) {
      calls.push(["switch", slot, id]);
      if (id === altId) throw new Error(`Brain "${id}" is an alternate: start it by id, it does not go in a slot.`);
      return { slot, id };
    },
    async chat(id, messages) {
      calls.push(["chat", id, messages]);
      return { content: `${id}: ${messages.at(-1).content}`, toolCalls: [], usage: null, tokensPerSecond: 1 };
    },
    async stopAll() {},
  };
  const bus = new Bus({ pingMs: 50 });
  const app = createServer({ root, port: 0, bus, brains, hardware: fakeHardware });
  const port = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const listed = (await call("GET", "/brains")).body;
    assert.equal(listed.at(-1).id, altId);
    assert.equal(listed.at(-1).alternate, true);
    assert.equal(listed.at(-1).engine, "colibri");

    const health = (await call("GET", "/health")).body;
    assert.deepEqual(health.brains.map((b) => b.id), ["qwen3.5-9b", "qwen3.5-4b"]);
    assert.equal(health.sizes.m.tier.titan, "qwen3.5-9b", "the legacy size resolver skipped the alternate with slot talk");
    assert.equal(JSON.stringify(health.sizes).includes(altId), false);

    const automatic = await call("POST", "/chat", { messages: [{ role: "user", content: "hello" }] });
    assert.equal(automatic.status, 200);
    assert.equal(automatic.body.brain, "qwen3.5-9b");
    const named = await call("POST", "/chat", { brain: altId, messages: [{ role: "user", content: "hello" }] });
    assert.equal(named.status, 200);
    assert.equal(named.body.brain, altId);
    assert.deepEqual(calls.filter((c) => c[0] === "start").map((c) => c[1]), ["qwen3.5-9b", altId]);

    const sw = await call("POST", "/brains/switch", { slot: "talk", id: altId });
    assert.equal(sw.status, 409);
    assert.match(sw.body.error, /is an alternate/);
    const q = await call("POST", "/quests", { task: "count the stars", brain: altId });
    assert.equal(q.status, 400);
    assert.match(q.body.error, /to take the Titan's seat/);
  } finally {
    await app.close();
  }
});

test("the queue hands out the oldest queued quest, and a runner starts with listen and closes with close", async () => {
  const runner = { started: null, closed: false, stops: [], start: (q) => void (runner.started = q), stop: (id) => (runner.stops.push(id), true), close: async () => void (runner.closed = true) };
  const bus = new Bus({ pingMs: 50 });
  const app = createServer({ root, port: 0, bus, brains: fakeBrains(), hardware: fakeHardware, runner });
  assert.equal(runner.started, null, "nothing runs before listen");
  await app.listen();
  try {
    assert.equal(runner.started, app.queue);
    assert.equal(app.queue.next(), null);
    const a = app.queue.add({ task: "first" });
    const b = app.queue.add({ task: "second" });
    assert.equal(app.queue.next(), a);
    a.status = "running";
    assert.equal(app.queue.next(), b);
    b.status = "stopped";
    assert.equal(app.queue.next(), null);
  } finally {
    await app.close();
  }
  assert.equal(runner.closed, true);
});

test("POST /quests/:id/stop: a queued quest stops at once, a running one goes to the runner, an unknown is 404", async () => {
  const runner = { start() {}, stop: (id) => (runner.stops.push(id), true), stops: [], close: async () => {} };
  const bus = new Bus({ pingMs: 50 });
  const app = createServer({ root, port: 0, bus, brains: fakeBrains(), hardware: fakeHardware, runner });
  const port = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call("POST", "/quests/q-nothing/stop")).status, 404);
    const queued = (await call("POST", "/quests", { task: "wait here" })).body;
    const done = [];
    bus.on("quest.done", (e) => done.push(e));
    const stop = await call("POST", `/quests/${queued.id}/stop`);
    assert.deepEqual(stop, { status: 200, body: { id: queued.id, status: "stopped" } });
    assert.deepEqual(done.map((e) => [e.id, e.status]), [[queued.id, "stopped"]]);
    assert.equal((await call("GET", `/quests/${queued.id}`)).body.status, "stopped");
    assert.deepEqual(runner.stops, [], "a queued quest never reaches the runner");
    // stopping it again changes nothing
    assert.equal((await call("POST", `/quests/${queued.id}/stop`)).body.status, "stopped");
    assert.equal(done.length, 1);

    const running = (await call("POST", "/quests", { task: "busy" })).body;
    app.queue.get(running.id).status = "running";
    const r = await call("POST", `/quests/${running.id}/stop`);
    assert.deepEqual(r, { status: 200, body: { id: running.id, status: "running", stopping: true } });
    assert.deepEqual(runner.stops, [running.id]);
    assert.equal((await call("GET", `/quests/${running.id}`)).body.stop, true);
    assert.deepEqual((await call("GET", "/health")).body.quests, { queued: 0, running: 1 });
  } finally {
    await app.close();
  }

  // without a runner, a running quest cannot be stopped
  const bare = await up();
  try {
    const q = (await bare.call("POST", "/quests", { task: "busy" })).body;
    bare.app.queue.get(q.id).status = "running";
    assert.equal((await bare.call("POST", `/quests/${q.id}/stop`)).status, 409);
  } finally {
    await bare.app.close();
  }
});

test("shutdown closes the app before stopping brains, so in-flight chats can settle as stopped", async () => {
  const calls = [];
  await shutdownRuntime({
    app: { bus: { emit: (type, data) => calls.push(`emit ${type} ${data.why}`) }, close: async () => calls.push("app.close") },
    brains: { stopAll: async () => calls.push("brains.stopAll") },
    stopHardware: () => calls.push("hardware.stop"),
    beacon: { stop: () => calls.push("beacon.stop") },
    ledger: { close: () => calls.push("ledger.close") },
    sig: "SIGTERM",
    log: (line) => calls.push(`log ${line}`),
    exit: (code) => calls.push(`exit ${code}`),
  });
  assert.deepEqual(calls, [
    "log chronos stopping (SIGTERM)",
    "emit log SIGTERM",
    "hardware.stop",
    "beacon.stop",
    "app.close",
    "brains.stopAll",
    "ledger.close",
    "exit 0",
  ]);
});

test("a body over 1 MiB is refused with 413 and bad JSON with 400", async () => {
  const { app, base } = await up();
  try {
    const big = await fetch(`${base}/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "x".repeat(1024 * 1024 + 10) }) }).catch(() => null);
    // the server may close the socket before the whole body is sent; either a 413 or a dropped connection is a refusal
    if (big) assert.equal(big.status, 413);
    const bad = await fetch(`${base}/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test("the real hardware and brains modules load into the server", { skip: !(has("hardware.mjs") && has("brains.mjs")) && "hardware.mjs or brains.mjs is not written yet" }, async () => {
  const bus = new Bus();
  const { hardware, brains, missing } = await loadModules({ root, bus });
  assert.deepEqual(missing, []);
  const app = createServer({ root, port: 0, bus, brains, hardware, missing });
  await app.listen();
  try {
    const health = await (await fetch(`${app.url()}/health`)).json();
    assert.equal(health.ok, true);
    assert.ok(health.hardware && typeof health.hardware.vram?.totalMiB === "number");
    assert.ok(Array.isArray(health.brains) && health.brains.length > 0);
    for (const b of health.brains) assert.ok(["idle", "loading", "ready", "failed"].includes(b.status), `status ${b.status}`);
    assert.equal(health.missing, undefined);
  } finally {
    await app.close();
    brains.dispose?.();
  }
});

test("the heat watchdog stops every brain after two samples at 93 C junction, ignores a one-sample spike, re-arms under 85 C, and trips again", async () => {
  const { app, bus, brains, call } = await up();
  const reading = (junctionC) => ({ vram: { totalMiB: 12288, usedMiB: 9000, freeMiB: 3288, card: "test" }, ram: { totalMiB: 30000, availableMiB: 12000 }, cpu: { threads: 16, load1: 8 }, heat: { junctionC, edgeC: junctionC - 10, critC: 100, cpuC: 90, hot: junctionC >= 90 }, at: Date.now() });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  try {
    await call("POST", "/brains/qwen3.5-9b/start");
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
    await app.close();
  }
});

// ---- sizes, quest.queued and the history of finished quests (docs/ui-contract.md 2.2 and 2.3) ----

const T9 = "qwen3.5-9b";
const W4 = "qwen3.5-4b";
const O08 = "qwen3.5-0.8b";
const T27 = "qwen3.8-27b";
const TIERS = {
  s: { titan: null, promethean: W4, offspring: O08, maxTasks: 1, tokens: 16000, seconds: 900, note: "no plan" },
  m: { titan: T9, promethean: W4, offspring: O08, maxTasks: 3, tokens: 64000, seconds: 2700, note: "as before" },
  l: { titan: T27, promethean: W4, offspring: O08, judge: T27, maxTasks: 5, tokens: 160000, seconds: 7200, note: "the main brain" },
};
const TIER = {
  s: { titan: null, promethean: W4, offspring: O08, judge: W4 },
  m: { titan: T9, promethean: W4, offspring: O08, judge: T9 },
  l: { titan: T27, promethean: W4, offspring: O08, judge: T27 },
};

/** a server whose brains have the catalogue's tiers; `absent` names the brains that are not on disk; no runner */
async function upSized({ home, absent = [] } = {}) {
  const bus = new Bus({ pingMs: 50 });
  const brains = {
    catalogue: { tiers: TIERS },
    list: () => [
      { id: T9, role: "talk", slot: "talk" },
      { id: W4, role: "promethean", slot: "promethean" },
      { id: O08, role: "offspring", slot: "offspring" },
      { id: T27, role: "titan", slot: "titan", exclusive: true },
    ].map((b) => ({ ...b, status: "idle", present: !absent.includes(b.id) })),
    async start() {},
    async stop() {},
    async chat() {
      return { content: "", toolCalls: [] };
    },
    async stopAll() {},
  };
  const app = createServer({ root, port: 0, bus, brains, hardware: fakeHardware, ...(home ? { home } : {}) });
  const port = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, bus, brains, call };
}

test("/health gains sizes: each tier with every brain's present flag, and where a size that cannot run falls", async () => {
  const all = await upSized();
  try {
    const { sizes } = (await all.call("GET", "/health")).body;
    assert.deepEqual(Object.keys(sizes), ["s", "m", "l"]);
    assert.deepEqual(sizes.s, { ok: true, tier: TIER.s, tokens: 16000, seconds: 900, maxTasks: 1, note: "no plan", present: { [W4]: true, [O08]: true } });
    assert.deepEqual(sizes.m.tier, TIER.m);
    assert.deepEqual(sizes.l, { ok: true, tier: TIER.l, tokens: 160000, seconds: 7200, maxTasks: 5, note: "the main brain", present: { [T27]: true, [W4]: true, [O08]: true } });
  } finally {
    await all.app.close();
  }

  const no27 = await upSized({ absent: [T27] });
  try {
    const { sizes } = (await no27.call("GET", "/health")).body;
    assert.equal(sizes.l.ok, false);
    assert.equal(sizes.l.fallsTo, "m");
    assert.equal(sizes.l.present[T27], false);
    assert.equal(sizes.l.why, `the Titan ${T27} is not on disk: a size l quest falls back to size m`);
    assert.equal(sizes.m.ok, true);
  } finally {
    await no27.app.close();
  }

  // brains with no tiers: one size, the brains in the slots
  const bare = await up();
  try {
    const { sizes } = (await bare.call("GET", "/health")).body;
    assert.deepEqual(Object.keys(sizes), ["m"]);
    assert.equal(sizes.m.ok, true);
    assert.deepEqual(sizes.m.tier, { titan: T9, promethean: W4, offspring: null, judge: T9 });
  } finally {
    await bare.app.close();
  }
});

test("POST /quests {task, by?, size?, brain?, budget?}: the quest is stamped with its size and tier, and the bus hears quest.queued and quest.started", async () => {
  const { app, bus, call } = await upSized();
  try {
    const heard = [];
    bus.on("event", (e) => (e.type === "quest.queued" || e.type === "quest.started") && heard.push(e));
    const strip = ({ t, n, ...e }) => e;

    // a size asked for outright, any case
    const s = await call("POST", "/quests", { task: "Count the stars", by: "hephaestus", size: "S" });
    assert.equal(s.status, 202);
    assert.deepEqual(s.body, { id: s.body.id, status: "queued", size: "s", tier: TIER.s });
    assert.deepEqual(heard.map(strip), [
      { type: "quest.queued", id: s.body.id, task: "Count the stars", by: "hephaestus", size: "s", tier: TIER.s },
      { type: "quest.started", id: s.body.id, task: "Count the stars", by: "hephaestus" },
    ]);
    assert.ok(heard[1].t - heard[0].t <= 1, "at the same moment");
    const one = (await call("GET", `/quests/${s.body.id}`)).body;
    assert.deepEqual([one.size, one.asked, one.status], ["s", "s", "queued"]);
    assert.deepEqual(one.tier, TIER.s);

    // the size named in the task's first line, stripped from the task
    const marked = await call("POST", "/quests", { task: "[size:l] Count the stars\nand name them", by: "hephaestus" });
    assert.deepEqual([marked.body.size, marked.body.tier], ["l", TIER.l]);
    assert.equal(app.queue.get(marked.body.id).task, "Count the stars\nand name them");
    assert.equal(heard.at(-1).task, "Count the stars\nand name them", "quest.started carries the task without the marker");
    const lead = await call("POST", "/quests", { task: "size: m\nRename a.txt to b.txt" });
    assert.equal(lead.body.size, "m");
    assert.equal(app.queue.get(lead.body.id).task, "Rename a.txt to b.txt");
    // asked outright wins over the marker; "auto" leaves the marker to say
    assert.equal((await call("POST", "/quests", { task: "[size:l] Count the stars", size: "s" })).body.size, "s");
    assert.equal((await call("POST", "/quests", { task: "[size:l] Count the stars", size: "auto" })).body.size, "l");

    // auto, by the task's words
    const small = await call("POST", "/quests", { task: "Rename a.txt to b.txt" });
    assert.equal(small.body.size, "s");
    assert.equal(app.queue.get(small.body.id).asked, "auto");
    assert.equal((await call("POST", "/quests", { task: "Count the stars and chart the ocean", size: "auto" })).body.size, "m");
    assert.equal((await call("POST", "/quests", { task: "Plan the survey and compare both designs" })).body.size, "l");

    // a brain for the Titan's seat, and a budget, stay on the quest
    const named = await call("POST", "/quests", { task: "Count the stars", size: "m", brain: T27, budget: { tokens: 5000, seconds: 60 } });
    assert.deepEqual(named.body.tier, { titan: T27, promethean: W4, offspring: O08, judge: T27 });
    const q = app.queue.get(named.body.id);
    assert.deepEqual([q.brain, q.budget], [T27, { tokens: 5000, seconds: 60 }]);
    assert.deepEqual(app.queue.get((await call("POST", "/quests", { task: "Count the stars", budget: { seconds: 30 } })).body.id).budget, { seconds: 30 });
    assert.equal(app.queue.get(s.body.id).budget, undefined);

    // what is refused, with the reason
    for (const [body, why] of [
      [{ task: "x", size: "xl" }, /no size "xl": a quest is auto, s, m or l/],
      [{ task: "x", size: 2 }, /no size 2/],
      [{ task: "x", brain: "gpt-9" }, /no brain "gpt-9" to take the Titan's seat/],
      [{ task: "x", budget: { tokens: -5 } }, /a budget is \{tokens\?, seconds\?\}/],
      [{ task: "x", budget: { seconds: "soon" } }, /a budget is/],
      [{ task: "x", budget: [100] }, /a budget is/],
      [{ task: "[size:l]" }, /a quest needs a task/],
      [{ task: "  " }, /a quest needs a task/],
    ]) {
      const r = await call("POST", "/quests", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, why);
    }
    const before = heard.length;
    assert.equal(heard.filter((e) => e.type === "quest.queued").length, heard.filter((e) => e.type === "quest.started").length);
    assert.equal(before, 20, "ten quests accepted, none of the refused ones");
  } finally {
    await app.close();
  }
});

test("the queue: a size whose Titan is not on disk is stamped with the size it falls to; an envoy's task may name a size; chat stays on the quest and its events", async () => {
  const { app, bus, call } = await upSized({ absent: [T27] });
  try {
    const fell = (await call("POST", "/quests", { task: "Count the stars", size: "l" })).body;
    assert.deepEqual([fell.size, fell.tier], ["m", TIER.m]);
    assert.equal(app.queue.get(fell.id).asked, "l", "what was asked is kept for the runner, which says the fallback when it takes the quest");

    // an envoy can only send text: its first line names the size
    const good = { id: "envoy-abc123-def456", key: "0123456789abcdef0123456789abcdef", from: { id: "hephaestus", name: "Hephaestus", port: 7331 }, ask: "[size:s] what time is it", by: "felipe" };
    const arrived = (await call("POST", "/bridge/arrive", good)).body;
    const envoy = (await call("GET", `/quests/${arrived.quest}`)).body;
    assert.deepEqual([envoy.task, envoy.size, envoy.tag], ["what time is it", "s", "envoy"]);
    const queued = bus.history.find((e) => e.type === "quest.queued" && e.id === arrived.quest);
    assert.deepEqual([queued.size, queued.tag, queued.envoy], ["s", "envoy", { id: good.id, from: good.from }]);
    assert.ok(!JSON.stringify(bus.history).includes(good.key), "the key is on no event");

    // a quest hired from a conversation carries its chat, on the quest and on quest.queued and quest.done
    const hired = app.queue.add({ task: "Count the stars", by: "ui", size: "s", chat: "c-abc" });
    assert.deepEqual([hired.size, hired.chat, hired.by], ["s", "c-abc", "ui"]);
    assert.equal(bus.history.find((e) => e.type === "quest.queued" && e.id === hired.id).chat, "c-abc");
    assert.equal(bus.history.find((e) => e.type === "quest.started" && e.id === hired.id).chat, undefined, "quest.started is as it always was");
    await call("POST", `/quests/${hired.id}/stop`);
    const done = bus.history.find((e) => e.type === "quest.done" && e.id === hired.id);
    assert.deepEqual([done.status, done.size, done.chat], ["stopped", "s", "c-abc"]);
    assert.deepEqual(done.tier, TIER.s);
    // a size that is no size is auto
    assert.equal(app.queue.add({ task: "Rename a.txt", size: "huge" }).size, "s");
  } finally {
    await app.close();
  }

  // a queue on its own (no server, no tiers): every quest is m, and the marker is still stripped
  const loneBus = new Bus();
  const lone = createQueue(loneBus);
  const q = lone.add({ task: "[size:l] think hard" });
  assert.deepEqual([q.task, q.size, q.asked], ["think hard", "m", "l"]);
  assert.deepEqual(q.tier, { titan: null, promethean: null, offspring: null, judge: null });
  assert.deepEqual(loneBus.history.map((e) => e.type), ["quest.queued", "quest.started"]);
  // an id the history already holds is never handed out again
  let asked = 0;
  const careful = createQueue(new Bus(), { known: () => ++asked < 3 });
  careful.add({ task: "x" });
  assert.equal(asked, 3, "it drew ids until one was free");
});

test("GET /quests?limit&before&status pages newest first without reports, and a second server on the same home still lists the finished quests", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-home-"));
  try {
    const first = await upSized({ home });
    assert.equal(first.app.history.file, path.join(home, "quests.jsonl"));
    const ids = [];
    for (const [i, body] of [
      { task: "Count the stars", by: "hephaestus", size: "s" },
      { task: "Chart the ocean", by: "owner", size: "m" },
      { task: "Plan the survey", by: "hephaestus", size: "l" },
      { task: "Name the moons", by: "felipe", size: "m" },
      { task: "Still waiting", by: "hephaestus", size: "s" },
    ].entries()) {
      const made = (await first.call("POST", "/quests", body)).body;
      first.app.queue.get(made.id).at = 1_700_000_000_000 + i * 1000; // a steady order in the past, whatever the clock did
      ids.push(made.id);
    }
    // the first finishes as a runner would end it, with its report; the next three are stopped before they start; the last stays queued
    const report = { id: ids[0], status: "done", summary: "Seven stars, written to stars.txt.", reports: [{ id: "wisp:cp-1", status: "done" }], judged: [] };
    first.app.queue.get(ids[0]).status = "running";
    first.bus.emit("quest.done", { id: ids[0], status: "done", size: "s", tier: TIER.s, summary: report.summary, report, trail: null });
    Object.assign(first.app.queue.get(ids[0]), { status: "done", summary: report.summary, report });
    for (const id of ids.slice(1, 4)) await first.call("POST", `/quests/${id}/stop`);

    const tasks = (list) => list.map((q) => q.task);
    const all = (await first.call("GET", "/quests")).body;
    assert.deepEqual(tasks(all), ["Still waiting", "Name the moons", "Plan the survey", "Chart the ocean", "Count the stars"], "newest first");
    assert.ok(all.every((q) => !("report" in q)), "the list leaves the report out");
    assert.deepEqual(all.map((q) => q.status), ["queued", "stopped", "stopped", "stopped", "done"]);
    assert.deepEqual(all.map((q) => q.size), ["s", "m", "l", "m", "s"]);
    assert.deepEqual(tasks((await first.call("GET", "/quests?limit=2")).body), ["Still waiting", "Name the moons"]);
    assert.deepEqual(tasks((await first.call("GET", `/quests?limit=2&before=${ids[3]}`)).body), ["Plan the survey", "Chart the ocean"]);
    assert.deepEqual(tasks((await first.call("GET", `/quests?before=${ids[0]}`)).body), []);
    assert.deepEqual(tasks((await first.call("GET", "/quests?status=stopped&limit=2")).body), ["Name the moons", "Plan the survey"]);
    assert.deepEqual(tasks((await first.call("GET", "/quests?status=done,queued")).body), ["Still waiting", "Count the stars"]);
    assert.deepEqual((await first.call("GET", `/quests/${ids[0]}`)).body.report, report, "one quest by id carries it");
    assert.equal(fs.readFileSync(path.join(home, "quests.jsonl"), "utf8").trim().split("\n").length, 4, "one line per finished quest");
    await first.app.close();

    // the restart: a second server on the same home
    const second = await upSized({ home });
    try {
      const list = (await second.call("GET", "/quests")).body;
      assert.deepEqual(tasks(list), ["Name the moons", "Plan the survey", "Chart the ocean", "Count the stars"], "the finished quests; the one still queued was lost with the process");
      assert.ok(list.every((q) => !("report" in q)));
      assert.deepEqual(list.map((q) => [q.status, q.size, q.by]), [["stopped", "m", "felipe"], ["stopped", "l", "hephaestus"], ["stopped", "m", "owner"], ["done", "s", "hephaestus"]]);
      assert.deepEqual(list[3].tier, TIER.s);
      assert.equal(list[3].summary, report.summary);
      assert.ok(list.every((q) => typeof q.doneAt === "number"));
      assert.deepEqual(tasks((await second.call("GET", `/quests?limit=1&before=${ids[3]}`)).body), ["Plan the survey"]);
      assert.deepEqual(tasks((await second.call("GET", "/quests?status=done")).body), ["Count the stars"]);
      // one by id comes from the history with its report; an unknown one is still a 404
      const one = await second.call("GET", `/quests/${ids[0]}`);
      assert.equal(one.status, 200);
      assert.deepEqual(one.body.report, report);
      assert.equal(one.body.task, "Count the stars");
      assert.equal((await second.call("GET", `/quests/${ids[4]}`)).status, 404, "a quest that never finished is gone");
      assert.deepEqual((await second.call("GET", "/health")).body.quests, { queued: 0, running: 0 }, "the history is not the queue");
      // the hires survive the restart: what Hephaestus and felipe sent, not the owner's own
      const { hires } = (await second.call("GET", "/link")).body;
      assert.equal(hires.total, 3);
      assert.deepEqual(hires.bySize, { s: 1, m: 1, l: 1 });
      assert.deepEqual(hires.last.map((q) => q.task), ["Name the moons", "Plan the survey", "Count the stars"]);
      // a new quest joins them at the top
      const fresh = (await second.call("POST", "/quests", { task: "Count the comets", by: "hephaestus", size: "s" })).body;
      assert.ok(!ids.includes(fresh.id));
      assert.equal((await second.call("GET", "/quests?limit=1")).body[0].id, fresh.id);
      assert.equal((await second.call("GET", "/link")).body.hires.total, 4);
    } finally {
      await second.app.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // a server made without a home keeps finished quests in memory only
  const bare = await upSized();
  try {
    assert.equal(bare.app.history.file, null);
    const made = (await bare.call("POST", "/quests", { task: "x" })).body;
    await bare.call("POST", `/quests/${made.id}/stop`);
    assert.equal(bare.app.history.size, 1);
    assert.equal((await bare.call("GET", "/quests")).body.length, 1);
  } finally {
    await bare.app.close();
  }
});

test("the real catalogue's tiers reach /health and the runner, with no brain started", { skip: !(has("hardware.mjs") && has("brains.mjs")) && "hardware.mjs or brains.mjs is not written yet" }, async () => {
  const bus = new Bus();
  const { hardware, brains, missing } = await loadModules({ root, bus });
  // the runner is made, never started: no quest is run and no brain is loaded here
  const runner = createRunner({ root, brains, hardware, bus });
  const app = createServer({ root, port: 0, bus, brains, hardware, missing });
  await app.listen();
  try {
    assert.deepEqual(Object.keys(runner.tiers), ["s", "m", "l"]);
    const { sizes } = await (await fetch(`${app.url()}/health`)).json();
    assert.deepEqual(Object.keys(sizes), ["s", "m", "l"]);
    assert.equal(sizes.s.tier.titan, null);
    assert.equal(sizes.m.tier.titan, T9);
    assert.equal(sizes.l.tier.titan, T27);
    assert.equal(sizes.l.tier.judge, T27);
    assert.equal(brains.list().find((b) => b.id === T27).exclusive, true, "the l Titan is alone on the GPU, so an l quest runs in phases");
    // whether the main brain is on this disk or not, /health and the runner agree on what an l quest runs as
    assert.equal(sizes.l.ok, sizes.l.present[T27]);
    const asL = runner.resolve({ task: "anything", size: "l" });
    assert.equal(asL.ok, sizes.l.ok || !!sizes.l.fallsTo);
    assert.equal(asL.size, sizes.l.ok ? "l" : (sizes.l.fallsTo ?? "l"));
    const stamped = app.queue.add({ task: "[size:l] anything", by: "test" });
    assert.equal(stamped.size, asL.size);
    assert.equal(stamped.task, "anything");
    // alternates are listed too; one that is only a catalogue entry (no port, no file) reads "catalogue", never "idle"
    assert.ok(brains.list().every((b) => b.status === "idle" || (b.alternate && b.status === "catalogue")), "nothing was started");
    assert.equal(app.history.file, null, "no home was named: nothing is written under ~/.chronos");
  } finally {
    await app.close();
    brains.dispose?.();
  }
});

test("/health says whether the governor runs here: the brains' own word, else what this system can do", async () => {
  const { app, call } = await up();
  try {
    const { governor } = (await call("GET", "/health")).body;
    assert.equal(typeof governor.runs, "boolean");
    assert.ok(governor.runs ? governor.why === null : typeof governor.why === "string" && governor.why.length > 10, "a governor that does not run says why");
  } finally {
    await app.close();
  }
  const brains = { ...fakeBrains(), governorStatus: () => ({ runs: false, why: "this system cannot pause a process (Windows has no SIGSTOP), so GPU brains run ungoverned" }) };
  const win = createServer({ root, port: 0, bus: new Bus({ pingMs: 50 }), brains, hardware: fakeHardware });
  const port = await win.listen();
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(health.governor, { runs: false, why: "this system cannot pause a process (Windows has no SIGSTOP), so GPU brains run ungoverned" });
  } finally {
    await win.close();
  }
});

test("a work folder apart from the code: the trail and /health's cwd follow it, the code folder is said beside it", async () => {
  const { writeTrail } = await import("./trail.mjs");
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-work-"));
  const app = createServer({ root, port: 0, bus: new Bus({ pingMs: 50 }), brains: fakeBrains(), hardware: fakeHardware, workdir });
  const port = await app.listen();
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  try {
    const health = await get("/health");
    assert.equal(health.cwd, workdir, "cwd is the work folder callers read");
    assert.equal(health.code, root, "code is where the runtime, the UI and the catalogue are");
    assert.deepEqual(await get("/trail"), [], "the work folder's trail, empty: not the code folder's");
    writeTrail({ root: workdir, title: "quest q-1: in the work folder", body: "# quest q-1\n\ndone there" });
    const trail = await get("/trail");
    assert.equal(trail.length, 1);
    assert.match(trail[0].name, /quest-q-1/);
    assert.equal((await get("/trail/verify")).ok, true);
    assert.equal((await get(`/trail/${trail[0].name}`)).markdown.includes("done there"), true);
    assert.ok(fs.existsSync(path.join(workdir, "brain", "docs-trail", trail[0].name)), "written under the work folder");
    assert.equal((await fetch(`http://127.0.0.1:${port}/ui/app.js`, { method: "HEAD" })).status, 200, "the UI still comes from the code folder");
  } finally {
    await app.close();
    fs.rmSync(workdir, { recursive: true, force: true });
  }
  // without one, everything is as before: cwd and code are the same folder
  const { app: plain, call } = await up();
  try {
    const h = (await call("GET", "/health")).body;
    assert.equal(h.cwd, root);
    assert.equal(h.code, root);
  } finally {
    await plain.close();
  }
});

test("POST /shutdown: trusted callers only, a 202 before it goes, and a refusal where nothing can shut it down", async () => {
  const reasons = [];
  const app = createServer({ root, port: 0, bus: new Bus({ pingMs: 50 }), brains: fakeBrains(), hardware: fakeHardware, onShutdown: async (why) => reasons.push(why) });
  const port = await app.listen();
  try {
    const foreign = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { origin: "https://elsewhere.example" } });
    assert.equal(foreign.status, 403);
    assert.deepEqual(reasons, [], "a page from elsewhere cannot stop the runtime");
    assert.equal((await fetch(`http://127.0.0.1:${port}/shutdown`)).status, 404, "a GET stops nothing");
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, stopping: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(reasons, ["POST /shutdown"], "called once, after the answer went out");
  } finally {
    await app.close();
  }
  const { app: plain, call } = await up();
  try {
    assert.equal((await call("POST", "/shutdown")).status, 409, "a server nobody can exit says so");
  } finally {
    await plain.close();
  }
});

test("the real runtime, started as a program on a throwaway home: the work folder, then POST /shutdown stops it, removes its beacon and exits 0", { timeout: 60_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-run-"));
  const home = path.join(dir, "home");
  const workdir = path.join(dir, "work", "deep");
  const estate = path.join(dir, "estate");
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  // no model is started: a runtime only starts a brain when it is asked for one
  const child = spawn(process.execPath, [path.join(root, "runtime", "server.mjs")], { env: { ...process.env, CHRONOS_HOME: home, CHRONOS_WORKDIR: workdir, CHRONOS_PORT: String(port), HEPHAESTUS_ESTATE_DIR: estate }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let health = null;
    // 40 s: a cold runner's first hardware reading (PowerShell on Windows, system_profiler on macOS) takes seconds
    for (let i = 0; i < 400 && !health; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    }
    assert.ok(health?.ok, `the runtime came up (${out.slice(-400)})`);
    assert.equal(health.cwd, workdir);
    assert.equal(health.code, root);
    assert.equal(typeof health.governor.runs, "boolean");
    assert.ok(health.brains.every((b) => b.status === "idle"), "no brain was started");
    assert.ok(fs.statSync(workdir).isDirectory(), "the work folder was made");
    const setup = await (await fetch(`http://127.0.0.1:${port}/setup`)).json();
    assert.equal(setup.home, home);
    assert.equal(setup.ready, false, "a throwaway home has no engine and no model");
    assert.equal(setup.engine.present, false);
    const beacon = path.join(estate, "runtimes", `${port}.json`);
    assert.ok(fs.existsSync(beacon), "its beacon is written");
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
    assert.equal(res.status, 202);
    const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    assert.ok(end, "it exited by itself");
    assert.deepEqual(end, { code: 0, signal: null });
    assert.equal(fs.existsSync(beacon), false, "its beacon is gone");
    assert.match(out, /chronos stopping \(POST \/shutdown\)/);
    assert.equal(fs.existsSync(path.join(root, "brain", "docs-trail", "nothing-written-here")), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
