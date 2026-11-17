// End to end, without real brains: the real Brains, the real runner and the real server, over a stand-in
// llama-server written where the engine goes (<home>/bin/llama/llama-server, the seam the brains and card lock
// tests use). The stand-in answers /health and /v1/chat/completions with scripted replies chosen by the system
// prompt (plan, split, judge, or a worker's turn) and by a marker in the task, and keeps every request it got.
// Everything is driven over HTTP on an ephemeral port with a temp home, as a caller would.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brains } from "./brains.mjs";
import { Bus } from "./bus.mjs";
import { createCardLock, readCardLock } from "./cardlock.mjs";
import { createRunner, MAX_DEPTH, QUEST_TURNS } from "./quests.mjs";
import { createServer } from "./server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T9 = "qwen3.5-9b";
const W4 = "qwen3.5-4b";
const O08 = "qwen3.5-0.8b";
const unix = process.platform === "win32" ? "the stand-in engine is a script with a #! line" : false;

/**
 * The stand-in llama-server. Markers in the task pick the script:
 *   FALLTASK  every worker says FALL (so a fall splits until the depth cap blocks it)
 *   LOOPTASK  every worker calls a tool forever (so only the turn cap ends the quest)
 *   otherwise a worker writes the file its task names and reports done
 * The planner plans one task for a marked quest and two otherwise; a split is never parsed (the mechanical halves
 * take over); every judge passes. Each request is one line in calls.jsonl beside the script.
 */
const FAKE_LLAMA = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
let n = 0;
const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
const answer = (message) => ({ choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }], usage, timings: { predicted_per_second: 50 } });
const say = (content) => answer({ content });
const tool = (name, a) => answer({ content: "", tool_calls: [{ id: "c" + ++n, type: "function", function: { name, arguments: JSON.stringify(a) } }] });
const fileOf = (task) => (task.match(/([\\w-]+\\.(?:txt|md))/) || [null, "out.txt"])[1];
function reply(body) {
  const messages = body.messages || [];
  const sys = (messages[0] && messages[0].content) || "";
  const user = (messages.find((m) => m.role === "user") || {}).content || "";
  const last = messages[messages.length - 1] || {};
  if (/You plan a quest/.test(sys)) {
    const rubric = ["the file exists", "what it holds is verified", "nothing else changed"];
    let tasks;
    if (/FALLTASK/.test(user)) tasks = [{ task: "FALLTASK chart the ocean into ocean.md", finish: "ocean.md lists the currents", rubric }];
    else if (/LOOPTASK/.test(user)) tasks = [{ task: "LOOPTASK list the files", finish: "never", rubric }];
    else tasks = [
      { task: "Count the stars and write the number to stars.txt", finish: "stars.txt holds the number", rubric },
      { task: "Name the moons in moons.txt", finish: "moons.txt names them", rubric },
    ];
    return say(JSON.stringify({ tasks }));
  }
  if (/You split one task/.test(sys)) return say("I cannot split that.");
  if (/You judge/.test(sys)) return say(JSON.stringify({ score: 0.9, verdict: "pass", note: "meets its rubric" }));
  // a worker's turn
  if (/FALLTASK/.test(user)) return say("FALL: too big for one worker");
  if (/LOOPTASK/.test(user)) return tool("glob", { pattern: "*.txt" });
  const file = fileOf(user);
  if (last.role === "tool") return say(JSON.stringify({ status: "done", summary: "Wrote " + file + ".", verified: [file + " holds the answer"], files: [file] }));
  return tool("write_file", { path: file, content: "7\\n" });
}
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = JSON.parse(data || "{}");
    const out = reply(body);
    fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ model: body.model, system: String((body.messages[0] || {}).content || "").slice(0, 40), text: JSON.stringify(body.messages) }) + "\\n");
    res.end(JSON.stringify(out));
  });
}).listen(port, "127.0.0.1");
`;

const cold = () => ({
  vram: { totalMiB: 12288, usedMiB: 1000, freeMiB: 11288, card: "test" },
  ram: { totalMiB: 30000, availableMiB: 20000 },
  cpu: { threads: 16, load1: 0.5 },
  heat: { junctionC: 60, edgeC: 50, critC: 100, cpuC: 70, hot: false },
  at: Date.now(),
});
const hardware = { readHardware: cold, fits: () => ({ ok: true, why: "" }), watchHardware: () => () => {} };

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A whole Lite on a temp home: the stand-in engine, the three brains' files, the real Brains (on the CPU unless
 * `card`), the runner, the server on an ephemeral port. `lockHome` is where the card lock lives.
 */
async function lite({ card = false, lockHome = null, cardWait = 10_000 } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-lite-e2e-"));
  const workdir = path.join(home, "work");
  mkdirSync(workdir, { recursive: true });
  const bus = new Bus({ pingMs: 1000 });
  const brains = new Brains({
    root: ROOT,
    home,
    bus,
    readJunction: () => NaN,
    hasCard: card,
    listDevices: () => "",
    vramTotalMiB: () => 0,
    gpu: async () => ({ ok: true, out: "" }),
    cardWait,
    cardPollMs: 25,
    ...(lockHome ? { cardHome: lockHome } : {}),
  });
  mkdirSync(path.join(home, "models"), { recursive: true });
  mkdirSync(path.dirname(brains.engine), { recursive: true });
  writeFileSync(brains.engine, FAKE_LLAMA);
  chmodSync(brains.engine, 0o755);
  for (const id of [T9, W4, O08]) {
    const b = brains.brainOf(id);
    b.port = await freePort();
    b.vramMiB = 0;
    b.ramMiB = 0; // the stand-in needs no memory, whatever this machine has free
    writeFileSync(path.join(home, "models", b.file), "not a real gguf");
  }
  const runner = createRunner({ root: workdir, brains, hardware, bus, coolPollMs: 5, settleMs: 0 });
  const app = createServer({ root: ROOT, home, port: 0, bus, brains, hardware, runner, workdir, uiDir: path.join(home, "no-ui") });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  /** poll GET /quests/:id until it is finished */
  const finished = async (id, ms = 30_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const q = (await call("GET", `/quests/${id}`)).body;
      if (!["queued", "running"].includes(q.status)) return q;
      if (Date.now() > until) throw new Error(`quest ${id} still ${q.status} after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const calls = () => {
    const file = path.join(path.dirname(brains.engine), "calls.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const close = async () => {
    await app.close();
    await brains.stopAll().catch(() => {});
    brains.dispose();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, workdir, bus, brains, app, port, base, call, finished, calls, close };
}

/** read GET /events?since=n until `until(events)` holds; each block's id and event */
function readEvents(port, since, until, { headers = {}, ms = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const got = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`the events did not come: ${got.length} read`));
    }, ms);
    const req = http.get({ host: "127.0.0.1", port, path: `/events${since === null ? "" : `?since=${since}`}`, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          got.push({ id: Number(block.match(/^id: (\d+)/m)?.[1]), ev: JSON.parse(data.slice(6)) });
        }
        if (until(got)) {
          clearTimeout(timer);
          req.destroy();
          resolve(got);
        }
      });
    });
    req.on("error", () => {});
  });
}

let L = null;
before(async () => {
  if (!unix) L = await lite();
});
after(async () => {
  await L?.close();
});

test("e2e 1: a size s quest runs to done: no plan, one Promethean on the 4B, judged by the 0.8B", { skip: unix, timeout: 60_000 }, async () => {
  const posted = await L.call("POST", "/quests", { task: "Count the stars and write the number to stars.txt", size: "s", by: "e2e" });
  assert.equal(posted.status, 202);
  assert.equal(posted.body.size, "s");
  const q = await L.finished(posted.body.id);
  assert.equal(q.status, "done", q.summary);
  assert.equal(q.report.size, "s");
  assert.equal(q.report.titan.brain, null, "no Titan in size s");
  assert.deepEqual(q.report.reports.map((r) => [r.tier, r.brain, r.status]), [["promethean", W4, "done"]]);
  assert.deepEqual(q.report.judged.map((j) => [j.author, j.by]), [[W4, O08]]);
  assert.equal(readFileSync(path.join(L.workdir, "stars.txt"), "utf8"), "7\n", "the worker's tool wrote into the work folder");
  assert.ok(!L.calls().some((c) => c.model === T9), "the 9B was never asked");
  assert.ok(existsSync(q.report.trail.file), "the trail entry is written");
});

test("e2e 2: a size m quest goes plan, work, judge to done, on the 9B and the 4B", { skip: unix, timeout: 60_000 }, async () => {
  const posted = await L.call("POST", "/quests", { task: "Count the stars and name the moons", size: "m" });
  const q = await L.finished(posted.body.id);
  assert.equal(q.status, "done", q.summary);
  assert.equal(q.report.size, "m");
  assert.deepEqual(q.report.tier, { titan: T9, promethean: W4, offspring: O08, judge: T9 });
  assert.equal(q.report.plan.length, 2, "the 9B planned two tasks");
  assert.deepEqual(q.report.phases.map((p) => [p.phase, p.brain]), [["plan", T9], ["work", W4], ["judge", T9]]);
  assert.ok(q.report.reports.every((r) => r.brain === W4 && r.status === "done"));
  assert.ok(q.report.judged.every((j) => j.by === T9 && j.verdict === "pass" && !j.advisory));
  const types = L.bus.history.filter((e) => e.id === q.id || e.quest === q.id).map((e) => e.type).filter((t) => t !== "log");
  assert.deepEqual(types.slice(0, 3), ["quest.queued", "quest.started", "quest.running"]);
  assert.equal(types.at(-1), "quest.done");
  assert.deepEqual(types.filter((t) => t === "quest.phase").length, 3);
});

test("e2e 3: a size l quest is accepted, downgraded to m with the note, and runs to done as m", { skip: unix, timeout: 60_000 }, async () => {
  const posted = await L.call("POST", "/quests", { task: "Count the stars and name the moons", size: "l" });
  assert.equal(posted.status, 202);
  assert.equal(posted.body.size, "m");
  assert.deepEqual(posted.body.downgraded, { from: "l", to: "m" });
  assert.equal(posted.body.note, "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m");
  const q = await L.finished(posted.body.id);
  assert.equal(q.status, "done", q.summary);
  assert.equal(q.report.size, "m");
  assert.deepEqual(q.report.downgraded, { from: "l", to: "m" });
  assert.ok(L.bus.history.some((e) => e.type === "log" && e.quest === q.id && /size l is not in Chronos Lite/.test(e.text)), "the runner says it too");
  // the marker in the task's first line does the same
  const marked = await L.call("POST", "/quests", { task: "[size:l] Count the stars" });
  assert.deepEqual([marked.body.size, marked.body.downgraded?.from], ["m", "l"]);
  await L.finished(marked.body.id);
});

test("e2e 4: a Promethean that falls splits into two Offspring, and they split again, until depth 2 blocks them", { skip: unix, timeout: 60_000 }, async () => {
  assert.equal(MAX_DEPTH, 2);
  const posted = await L.call("POST", "/quests", { task: "FALLTASK chart the ocean", size: "m" });
  const q = await L.finished(posted.body.id);
  assert.equal(q.status, "blocked", q.summary);
  assert.equal(q.report.splits, 3, "the 4B's fall and the two Offspring's at depth 1 split; nothing at depth 2 does");
  const byDepth = (d) => q.report.reports.filter((r) => r.depth === d);
  assert.deepEqual(byDepth(0).map((r) => [r.tier, r.brain, r.status]), [["promethean", W4, "fell"]]);
  assert.deepEqual(byDepth(1).map((r) => [r.tier, r.brain, r.status]), [["offspring", O08, "fell"], ["offspring", O08, "fell"]]);
  assert.equal(byDepth(2).length, 4);
  assert.ok(byDepth(2).every((r) => r.status === "blocked" && /fell at depth 2, the cap/.test(r.blocked)));
  assert.equal(Math.max(...q.report.reports.map((r) => r.depth)), 2, "nothing spawned past depth 2");
  const splits = L.bus.history.filter((e) => e.type === "agent.split" && e.quest === q.id);
  assert.deepEqual(splits.map((e) => e.depth), [1, 2, 2]);
});

test("e2e 5: the 25-turn cap: a quest that would loop forever stops after 25 brain calls, with the reason", { skip: unix, timeout: 120_000 }, async () => {
  assert.equal(QUEST_TURNS, 25);
  const before = L.calls().length;
  const posted = await L.call("POST", "/quests", { task: "LOOPTASK list the files", size: "m" });
  const q = await L.finished(posted.body.id, 90_000);
  assert.equal(q.status, "stopped", q.summary);
  assert.equal(q.report.why, "the quest passed its cap of 25 brain turns");
  assert.equal(q.report.caps.turns, 25);
  const made = L.calls().slice(before).filter((c) => c.text.includes("LOOPTASK"));
  assert.equal(made.length, 25, "exactly 25 brain calls reached a brain");
  assert.ok(q.report.usage.turns > 25, "the call past the cap was counted and refused");
});

test("e2e 6: /events?since=n replays only what came after n from the ring, then streams live", { skip: unix, timeout: 60_000 }, async () => {
  const mark = L.bus.n;
  const posted = await L.call("POST", "/quests", { task: "Name the moons in moons.txt", size: "s" });
  await L.finished(posted.body.id);
  const doneOf = (got) => got.some((b) => b.ev.type === "quest.done" && b.ev.id === posted.body.id);
  const got = await readEvents(L.port, mark, doneOf);
  assert.ok(got.length > 3);
  assert.ok(got.every((b) => b.ev.n > mark), "nothing from before n");
  assert.deepEqual(got.map((b) => b.id), got.map((b) => b.ev.n), "each block's id is its n");
  for (let i = 1; i < got.length; i++) assert.ok(got[i].ev.n > got[i - 1].ev.n, "in order");
  assert.equal(got[0].ev.type, "quest.queued");
  assert.equal(got[0].ev.id, posted.body.id);
  // a reconnecting EventSource says the same with Last-Event-ID, and then hears what comes live
  const last = got.at(-1).ev.n;
  const live = readEvents(L.port, null, (g) => g.some((b) => b.ev.type === "log" && b.ev.text === "e2e live"), { headers: { "last-event-id": String(last) } });
  await new Promise((r) => setTimeout(r, 100));
  L.bus.emit("log", { text: "e2e live" });
  const tail = await live;
  assert.ok(tail.every((b) => b.ev.n > last));
  assert.equal(tail.at(-1).ev.text, "e2e live");
});

test("e2e 7: an idempotency key makes a retry answer the same quest, not a second one", { skip: unix, timeout: 60_000 }, async () => {
  const key = `e2e-${Date.now()}`;
  const a = await L.call("POST", "/quests", { task: "Count the stars and write the number to stars.txt", size: "s" }, { "idempotency-key": key });
  const b = await L.call("POST", "/quests", { task: "Count the stars and write the number to stars.txt", size: "s" }, { "idempotency-key": key });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.duplicate, true);
  await L.finished(a.body.id);
  const c = await L.call("POST", "/quests", { task: "Count the stars and write the number to stars.txt", size: "s" }, { "idempotency-key": key });
  assert.equal(c.body.id, a.body.id, "still the same after it finished");
  assert.equal(c.body.status, "done");
  assert.equal((await L.call("GET", "/quests")).body.quests.filter((q) => q.id === a.body.id).length, 1);
});

test("e2e 8: a POST from a foreign Origin gets 403 and makes no quest; a localhost page is let in", { skip: unix, timeout: 60_000 }, async () => {
  const count = () => L.app.queue.list().length;
  const n = count();
  const foreign = await L.call("POST", "/quests", { task: "Count the stars" }, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.match(foreign.body.error, /only this computer/);
  assert.equal(count(), n, "no quest was made");
  assert.equal((await L.call("POST", `/quests/${L.app.queue.list()[0].id}/stop`, {}, { origin: "http://attacker.test:7778" })).status, 403);
  const pre = await fetch(`${L.base}/quests`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(pre.status, 403);
  const local = await L.call("POST", "/quests", { task: "Name the moons in moons.txt", size: "s" }, { origin: "http://localhost:5173" });
  assert.equal(local.status, 202);
  await L.finished(local.body.id);
});

test("e2e 9: a second holder of the card lock is refused: while another Chronos holds the card, Lite's GPU brain waits, then fails, and the lock stays theirs", { skip: unix, timeout: 60_000 }, async () => {
  const lockHome = mkdtempSync(path.join(os.tmpdir(), "chronos-full-home-"));
  // a full Chronos on 7777 holds the card: a live process whose lock is in the shared home
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const theirs = createCardLock({ home: lockHome, pid: holder.pid, port: 7777, what: "chronos" });
  assert.equal(theirs.tryTake(T9).ok, true);
  const G = await lite({ card: true, lockHome, cardWait: 400 });
  try {
    assert.equal(G.brains.card.file, path.join(lockHome, "run", "gpu.lock"), "Lite reads the shared lock, not its own home's");
    const health = (await G.call("GET", "/health")).body;
    assert.deepEqual([health.card.lock.port, health.card.lock.pid, health.card.mine], [7777, holder.pid, false]);
    const posted = await G.call("POST", "/quests", { task: "Count the stars and write the number to stars.txt", size: "s" });
    const q = await G.finished(posted.body.id);
    assert.notEqual(q.status, "done", "nothing ran on the card");
    const waiting = G.bus.history.find((e) => e.type === "brain.waiting" && e.id === W4);
    assert.ok(waiting, "the 4B waited for the card");
    assert.equal(waiting.holder.port, 7777);
    assert.match(waiting.text, /the card is in use by .*the Chronos on port 7777/);
    assert.ok(G.bus.history.some((e) => /the card is in use by .*did not start/.test(e.text ?? e.why ?? e.summary ?? "")), "the refusal names the holder");
    assert.ok(!G.calls().some((c) => c.model === W4), "the 4B never answered: it never started");
    const lock = readCardLock(lockHome);
    assert.equal(lock.pid, holder.pid, "the lock is still the other Chronos's");
    assert.equal(lock.port, 7777);
  } finally {
    await G.close();
    theirs.release();
    holder.kill("SIGKILL");
    rmSync(lockHome, { recursive: true, force: true });
  }
});
