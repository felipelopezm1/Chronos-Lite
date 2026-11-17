#!/usr/bin/env node
// A stand-in for the Chronos Lite service, for building and checking the UI without a
// card or any model: it serves ./ui and answers the service's routes with scripted work.
// Zero dependencies. Nothing it says is real; it never touches a model or the card lock.
//
//   node scripts/mock-runtime.mjs [--port 7779] [--brand file.json] [--name "Acme Agents"]
//        [--short Acme] [--accent "#1d4ed8"] [--logo url] [--speed 1] [--seed] [--hold 600] [--no-drop] [--cycle]
//
// A size s task: one worker. A size m task: the planner plans three steps, the second
// worker cannot finish and its step is split between two helpers, then the planner
// reviews. The first live m task also drops every /events stream once, mid-way, so the
// page's reconnect with ?since= is exercised. --seed starts with one finished s task,
// one finished m task and one m task held mid-work (for screenshots) for --hold seconds, beside one
// that failed and one that was stopped. A task with the word "fail" in it fails: its brain will
// not start, its worker is blocked and it comes back failed. --cycle sends a new task every 40 s
// (quick, thorough, one that fails), so an open page shows every state of the face: working,
// thinking (plan and judge), speaking (what came back), done, held (a failure, the heat), and a
// split. The mock streams a hardware.read every 2 s, as the service does.
// Test hooks: POST /__mock/drop ends every event stream; POST /__mock/down?seconds=n
// answers 503 on every service route for n seconds; POST /__mock/heat?seconds=n holds a
// heat.cutoff for n seconds, then heat.clear.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.MOCK_PORT ?? 7779);
const HOST = args.host ?? "127.0.0.1";
const SPEED = Math.max(0.05, Number(args.speed ?? 1));
const UI = path.join(ROOT, "ui");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) out[k] = true;
    else ((out[k] = v), i++);
  }
  return out;
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
};

/* ---------- the edition and the brand ---------- */

const edition = readJson(path.join(ROOT, "lite/edition.json"));
const brand = { ...readJson(path.join(ROOT, "lite/brand.json")), ...(args.brand ? readJson(path.resolve(String(args.brand))) : {}) };
for (const [flag, key] of [["name", "name"], ["short", "shortName"], ["accent", "accent"], ["logo", "logo"]]) if (typeof args[flag] === "string") brand[key] = args[flag];
const NAME = brand.name || "Chronos Lite";
const VERSION = edition.version ?? "0.0.0";
const CAPS = { brains: edition.brains?.max ?? 3, sizes: edition.sizes ?? ["s", "m"], cards: edition.cards ?? 1, turns: edition.quest?.maxTurns ?? 25, splitDepth: edition.quest?.splitDepth ?? 2, tools: edition.tools?.max ?? 8 };
const editionBody = () => ({ name: NAME, shortName: brand.shortName || NAME, accent: brand.accent ?? null, logo: brand.logo ?? null, builtOn: brand.builtOn || "built on Chronos", version: VERSION, caps: CAPS, vocabulary: brand.vocabulary ?? null, avatar: brand.avatar ?? null, words: brand.words ?? null });

/* ---------- the models ---------- */

const BRAINS = [
  { id: "qwen3.5-9b", role: "talk", slot: "talk", status: "idle", present: true },
  { id: "qwen3.5-4b", role: "promethean", slot: "promethean", status: "idle", present: true },
  { id: "qwen3.5-0.8b", role: "offspring", slot: "offspring", status: "idle", present: true },
];
const TIER = { s: { titan: null, promethean: "qwen3.5-4b", offspring: "qwen3.5-0.8b", judge: "qwen3.5-4b" }, m: { titan: "qwen3.5-9b", promethean: "qwen3.5-4b", offspring: "qwen3.5-0.8b", judge: "qwen3.5-9b" } };
const brainSet = (id, status, t) => {
  const b = BRAINS.find((x) => x.id === id);
  if (!b || b.status === status) return;
  b.status = status;
  emit(`brain.${status === "idle" ? "stopped" : status}`, { id, port: 7710 + BRAINS.indexOf(b) * 10, pid: status === "idle" ? null : 40000 + BRAINS.indexOf(b) }, t);
};

/* ---------- the bus: a ring of events, streamed as SSE ---------- */

const ring = [];
let n = 0;
const clients = new Set();
function emit(type, data = {}, t = Date.now()) {
  const ev = { n: ++n, t, type, ...data };
  ring.push(ev);
  if (ring.length > 2000) ring.shift();
  const block = `id: ${ev.n}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(block);
  return ev;
}
function dropStreams(why) {
  for (const res of clients) res.end();
  const count = clients.size;
  clients.clear();
  if (count) console.log(`mock: dropped ${count} event stream(s): ${why}`);
}

/* ---------- tasks ---------- */

const quests = new Map();
const waiting = [];
let current = null;
let dropped = Boolean(args["no-drop"]);
let downUntil = 0;

const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
function autoSize(task) {
  const t = task.toLowerCase();
  return task.length > 140 || /\b(plan|design|compare|research|report|and then|review)\b/.test(t) ? "m" : "s";
}

function add({ task, size = "auto", by = null }, { id = rid("q"), t = Date.now() } = {}) {
  const asked = { small: "s", medium: "m", large: "l" }[String(size || "auto").toLowerCase()] ?? String(size || "auto").toLowerCase();
  const downgraded = asked === "l" ? { from: "l", to: "m" } : null;
  const sz = asked === "s" || asked === "m" ? asked : downgraded ? "m" : autoSize(task);
  const q = { id, task, by, status: "queued", at: t, size: sz, tier: TIER[sz], asked, summary: "", report: null, ...(downgraded ? { downgraded, note: "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m" } : {}) };
  quests.set(id, q);
  emit("quest.queued", { id, task, by, size: sz, tier: q.tier, ...(downgraded ? { downgraded } : {}) }, t);
  emit("quest.started", { id, task, by }, t);
  return q;
}

/** The scripted run of one task, as [delay ms, step] pairs. */
function script(q) {
  const steps = [];
  const at = (ms, fn) => steps.push([ms, fn]);
  const ag = { ti: rid("wisp:ck"), w: [rid("wisp:cp"), rid("wisp:cp"), rid("wisp:cp")], h: [rid("wisp:co"), rid("wisp:co")] };
  const id = q.id;
  at(400, (t) => {
    q.status = "running";
    emit("quest.running", { id, size: q.size, tier: q.tier, ...(q.downgraded ? { downgraded: q.downgraded } : {}) }, t);
    if (q.downgraded) emit("log", { quest: id, text: `size l is not in Lite: this quest runs as m`, size: "m" }, t);
  });
  if (/\bfail/i.test(q.task)) {
    at(600, (t) => brainSet("qwen3.5-4b", "loading", t));
    at(300, (t) => emit("agent.spawned", { id: ag.w[0], kind: "wisp", tier: "promethean", parent: null, brain: "qwen3.5-4b", task: q.task, depth: 0, quest: id }, t));
    at(1800, (t) => {
      BRAINS.find((x) => x.id === "qwen3.5-4b").status = "failed";
      emit("brain.failed", { id: "qwen3.5-4b", port: 7720, pid: null, why: "llama-server exited: not enough free VRAM for the 4B (a mock)" }, t);
    });
    at(500, (t) => emit("agent.done", { id: ag.w[0], status: "blocked", tier: "promethean", parent: null, quest: id, summary: "The brain would not start, so nothing was done." }, t));
    at(300, (t) => {
      finish(q, "failed", "", [], t, "the 4B brain failed to start: not enough free VRAM");
      BRAINS.find((x) => x.id === "qwen3.5-4b").status = "idle";
    });
    return steps;
  }
  if (q.size === "s") {
    at(600, (t) => brainSet("qwen3.5-4b", "loading", t));
    at(1400, (t) => brainSet("qwen3.5-4b", "ready", t));
    at(300, (t) => emit("agent.spawned", { id: ag.w[0], kind: "wisp", tier: "promethean", parent: null, brain: "qwen3.5-4b", task: q.task, depth: 0, quest: id }, t));
    at(1500, (t) => emit("log", { id: ag.w[0], quest: id, text: "read_file notes/inbox.md (2.1 kB)" }, t));
    at(1500, (t) => emit("log", { id: ag.w[0], quest: id, text: "write_file answer.md (14 lines)" }, t));
    at(1200, (t) => emit("agent.done", { id: ag.w[0], status: "done", tier: "promethean", parent: null, quest: id, summary: "Wrote answer.md with the six open items, each with its owner and date.", files: ["answer.md"] }, t));
    at(500, (t) => finish(q, "done", "Wrote answer.md: six open items, each with its owner and date.", ["answer.md"], t));
    return steps;
  }
  const plan = ["Gather the open items from the notes folder", "Group them by area and find duplicates", "Write the summary with an owner for each item"];
  q.plan = plan.map((task) => ({ task, rubric: ["every item has an owner"] }));
  q.judged = [];
  q.splits = 1;
  at(600, (t) => brainSet("qwen3.5-9b", "loading", t));
  at(1600, (t) => brainSet("qwen3.5-9b", "ready", t));
  at(200, (t) => {
    emit("agent.spawned", { id: ag.ti, kind: "wisp", tier: "titan", parent: null, brain: "qwen3.5-9b", task: q.task, depth: 0, quest: id }, t);
    emit("quest.phase", { id, phase: "plan", brain: "qwen3.5-9b" }, t);
  });
  at(2200, (t) => emit("log", { id: ag.ti, quest: id, text: `the Titan planned 3 tasks` }, t));
  at(400, (t) => {
    emit("quest.phase", { id, phase: "work", brain: "qwen3.5-4b" }, t);
    brainSet("qwen3.5-4b", "loading", t);
  });
  at(1200, (t) => brainSet("qwen3.5-4b", "ready", t));
  plan.forEach((task, i) => at(250, (t) => emit("agent.spawned", { id: ag.w[i], kind: "wisp", tier: "promethean", parent: ag.ti, brain: "qwen3.5-4b", task, depth: 0, quest: id }, t)));
  at(1800, (t) => emit("log", { id: ag.w[0], quest: id, text: "grep 'TODO|open' notes/ (31 matches)" }, t));
  at(1400, (t) => emit("agent.done", { id: ag.w[0], status: "done", tier: "promethean", parent: ag.ti, quest: id, summary: "Found 31 open items across 9 notes." }, t));
  at(1600, (t) => emit("agent.done", { id: ag.w[1], status: "fell", tier: "promethean", parent: ag.ti, quest: id, summary: "Ran out of context while grouping 31 items." }, t));
  at(300, (t) => {
    emit("agent.split", { id: ag.w[1], children: ag.h, depth: 1, quest: id, why: "the context filled before the grouping was done" }, t);
    brainSet("qwen3.5-0.8b", "loading", t);
  });
  at(800, (t) => {
    brainSet("qwen3.5-0.8b", "ready", t);
    emit("agent.spawned", { id: ag.h[0], kind: "wisp", tier: "offspring", parent: ag.w[1], brain: "qwen3.5-0.8b", task: "Group items 1 to 16 by area", depth: 1, quest: id }, t);
    emit("agent.spawned", { id: ag.h[1], kind: "wisp", tier: "offspring", parent: ag.w[1], brain: "qwen3.5-0.8b", task: "Group items 17 to 31 by area", depth: 1, quest: id }, t);
  });
  at(0, () => "hold"); // where a seeded task waits
  at(600, () => {
    if (!dropped && !q.seeded) {
      dropped = true;
      dropStreams("the scripted drop in the first m task");
    }
  });
  at(1800, (t) => emit("agent.done", { id: ag.h[0], status: "done", tier: "offspring", parent: ag.w[1], quest: id, summary: "Grouped 16 items into 4 areas." }, t));
  at(900, (t) => emit("agent.done", { id: ag.h[1], status: "done", tier: "offspring", parent: ag.w[1], quest: id, summary: "Grouped 15 items into 3 areas; 2 duplicates merged." }, t));
  at(1500, (t) => emit("agent.done", { id: ag.w[2], status: "done", tier: "promethean", parent: ag.ti, quest: id, summary: "Wrote summary.md: 29 items in 6 areas, each with an owner.", files: ["summary.md"] }, t));
  at(400, (t) => emit("quest.phase", { id, phase: "judge", brain: "qwen3.5-9b" }, t));
  const scored = [[ag.w[0], 0.9], [ag.h[0], 0.8], [ag.h[1], 0.7], [ag.w[2], 0.85]];
  scored.forEach(([who, score]) =>
    at(700, (t) => {
      q.judged.push({ id: who, tier: who.startsWith("wisp:co") ? "offspring" : "promethean", by: "qwen3.5-9b", score, verdict: "pass", note: score < 0.8 ? "two owners are guesses" : "" });
      emit("log", { id: who, quest: id, judge: "qwen3.5-9b", score, text: `qwen3.5-9b judged ${who}: ${score} pass` }, t);
    }),
  );
  at(800, (t) => emit("agent.done", { id: ag.ti, status: "done", tier: "titan", parent: null, quest: id, summary: "Every step passed review." }, t));
  at(300, (t) => finish(q, "done", "summary.md lists 29 open items in 6 areas, each with an owner; 2 duplicates were merged.", ["summary.md"], t));
  return steps;
}

function finish(q, status, summary, files, t = Date.now(), why = null) {
  q.status = status;
  q.summary = summary;
  q.report = { status, summary, size: q.size, tier: q.tier, files: files ?? [], ...(why ? { why } : {}), ...(q.plan ? { plan: q.plan, judged: q.judged ?? [], splits: q.splits ?? 0 } : {}) };
  q.doneAt = t;
  emit("quest.done", { id: q.id, status, size: q.size, tier: q.tier, summary, ...(why ? { why } : {}), report: q.report, trail: null }, t);
  for (const b of BRAINS) if (b.status !== "idle" && b.role !== "offspring") brainSet(b.id, "idle", t);
}

/** Run a task's script on timers; a stop clears them and ends it at once. */
function run(q) {
  current = q;
  const steps = script(q);
  let i = 0;
  const next = () => {
    if (i >= steps.length || q.status === "done") return done();
    if (q.status !== "running" && q.status !== "queued") return;
    const [ms, fn] = steps[i++];
    q.timer = setTimeout(() => {
      if (fn(Date.now()) === "hold" && q.holdMs) return (q.timer = setTimeout(next, q.holdMs));
      next();
    }, ms / SPEED);
  };
  const done = () => {
    current = null;
    pump();
  };
  q.end = done;
  next();
}
function pump() {
  if (current) return;
  const q = waiting.shift();
  if (q) run(q);
}

function stop(q) {
  if (q.status === "queued") {
    waiting.splice(waiting.indexOf(q), 1);
    finish(q, "stopped", "stopped before it started", []);
    return;
  }
  clearTimeout(q.timer);
  q.status = "stopping";
  setTimeout(() => {
    stopNow(q);
    q.end?.();
  }, 900 / SPEED);
}

/** End a task as stopped: every agent still open stops between turns. */
function stopNow(q, t = Date.now()) {
  const open = new Map();
  for (const ev of ring) if (ev.quest === q.id && ev.type === "agent.spawned") open.set(ev.id, ev);
  for (const ev of ring) if (ev.quest === q.id && ev.type === "agent.done") open.delete(ev.id);
  emit("log", { quest: q.id, text: "stop asked: the workers finish their turn and halt" }, t);
  for (const a of open.values()) emit("agent.done", { id: a.id, status: "stopped", tier: a.tier, parent: a.parent, quest: q.id, summary: "Stopped between turns." }, t);
  finish(q, "stopped", "Stopped on request; what was finished is kept.", [], t);
}

/** --seed: two finished tasks in the past and one m task held after its split. */
function seed() {
  const ago = (min) => Date.now() - min * 60_000;
  for (const [task, size, min, id] of [["List the open items in the notes folder", "s", 42, "q-demo1"], ["Plan and write a summary of every open item in the notes folder, grouped by area, with an owner for each", "m", 18, "q-demo2"]]) {
    const q = add({ task, size, by: "ui" }, { id, t: ago(min) });
    q.seeded = true;
    let t = q.at;
    for (const [ms, fn] of script(q)) fn((t += ms));
  }
  // one that failed and one that was stopped part-way, in the past
  {
    const q = add({ task: "Rebuild the search index and fail loudly when a file cannot be read", size: "s", by: "hephaestus" }, { id: "q-demo4", t: ago(12) });
    q.seeded = true;
    let t = q.at;
    for (const [ms, fn] of script(q)) fn((t += ms));
  }
  {
    const q = add({ task: "Plan a migration of the notes folder into dated subfolders", size: "m", by: "ui" }, { id: "q-demo5", t: ago(6) });
    q.seeded = true;
    let t = q.at;
    for (const [ms, fn] of script(q).slice(0, 9)) fn((t += ms));
    stopNow(q, t + 400);
  }
  for (const b of BRAINS) b.status = "idle";
  const q = add({ task: "Compare this quarter's support notes with last quarter's and write a short report of what changed", size: "m", by: "ui" }, { id: "q-demo3", t: ago(1) });
  q.seeded = true;
  q.holdMs = Number(args.hold ?? 600) * 1000;
  run(q);
}

/* ---------- HTTP ---------- */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const row = (q, full = false) => ({ id: q.id, task: q.task, by: q.by, status: q.status === "stopping" ? "running" : q.status, at: q.at, size: q.size, tier: q.tier, asked: q.asked, ...(q.downgraded ? { downgraded: q.downgraded, note: q.note } : {}), ...(q.summary ? { summary: q.summary } : {}), ...(full && q.report ? { report: q.report } : {}) });
const counts = () => ({ queued: [...quests.values()].filter((q) => q.status === "queued").length, running: current ? 1 : 0 });

/** what the hardware sense would read: the VRAM the ready brains hold, and a junction that warms while they work */
let junction = 52;
let heatUntil = 0;
function hardware() {
  const used = BRAINS.reduce((s, b) => s + (b.status === "ready" ? { talk: 6100, promethean: 3300, offspring: 900 }[b.role] : 0), 300);
  const busy = current && current.status === "running";
  junction += ((busy ? 71 : 50) - junction) * 0.08 + (Math.random() - 0.5) * 0.6;
  const hot = heatUntil > Date.now();
  const j = Math.round(hot ? 96 : junction);
  return { vram: { totalMiB: 12272, usedMiB: used, freeMiB: 12272 - used, card: "a mock card" }, ram: { totalMiB: 31000, availableMiB: 19500 }, cpu: { threads: 16, load1: busy ? 3.2 : 0.6 }, heat: { junctionC: j, edgeC: j - 9, critC: 100, cpuC: 58, hot }, at: Date.now() };
}

function health() {
  const busy = current && current.status !== "queued";
  return {
    ok: true,
    kind: "chronos",
    edition: "lite",
    name: NAME,
    version: VERSION,
    builtOn: brand.builtOn || "built on Chronos",
    port: PORT,
    brains: BRAINS.map((b) => ({ ...b })),
    governor: { runs: false, why: "a mock: nothing to govern" },
    hardware: hardware(),
    card: { lock: busy ? { pid: process.pid, port: PORT, brain: current.size === "m" ? "qwen3.5-9b" : "qwen3.5-4b", since: current.at, host: "localhost", what: "chronos-lite", id: "mock", engines: [] } : null, mine: Boolean(busy), stale: false },
    quests: counts(),
    sizes: { s: { ok: true, tier: TIER.s, tokens: 16000, seconds: 900, maxTasks: 1, note: "no plan: one worker on the 4B" }, m: { ok: true, tier: TIER.m, tokens: 64000, seconds: 2700, maxTasks: 3, note: "the 9B plans and judges" } },
    capabilities: { hash: "mock", url: "/capabilities" },
    mock: true,
  };
}

function serveStatic(req, res, p) {
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const file = path.resolve(UI, rel);
  if (!file.startsWith(UI + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: `no route ${req.method} ${p}` });
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

async function body(req) {
  let s = "";
  for await (const c of req) s += c;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock");
  const p = url.pathname;
  try {
    if (p.startsWith("/__mock/") && req.method === "POST") {
      if (p === "/__mock/drop") return dropStreams("POST /__mock/drop"), send(res, 200, { ok: true });
      if (p === "/__mock/heat") {
        const seconds = Number(url.searchParams.get("seconds") ?? 8);
        heatUntil = Date.now() + seconds * 1000;
        emit("heat.cutoff", { junctionC: 96, cutoffC: 95, text: "the junction stayed at 96 C: every brain was stopped until it cools" });
        setTimeout(() => emit("heat.clear", { junctionC: 80, text: "the junction cooled to 80 C: brains may start again" }), seconds * 1000);
        return send(res, 200, { ok: true, seconds });
      }
      if (p === "/__mock/down") {
        downUntil = Date.now() + Number(url.searchParams.get("seconds") ?? 10) * 1000;
        dropStreams("POST /__mock/down");
        return send(res, 200, { ok: true, until: downUntil });
      }
    }
    const route = ["/health", "/capabilities", "/edition", "/events", "/quests"].includes(p) || p.startsWith("/quests/");
    if (route && Date.now() < downUntil) return send(res, 503, { error: "the mock is down on purpose" });

    if (req.method === "GET") {
      if (p === "/health") return send(res, 200, health());
      if (p === "/edition") return send(res, 200, editionBody());
      if (p === "/capabilities") return send(res, 200, { schema: "chronos-lite.capabilities/1", kind: "chronos", edition: "lite", version: VERSION, hash: "mock", name: NAME, builtOn: brand.builtOn || "built on Chronos", port: PORT, routes: (edition.service?.routes ?? []).map((r) => ({ method: r.split(" ")[0], path: r.split(" ")[1] })), sizes: health().sizes, cutSizes: { l: "m" }, caps: CAPS, tools: edition.tools?.names ?? [], brains: BRAINS.map((b) => ({ ...b, device: null })), mock: true });
      if (p === "/quests") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const status = url.searchParams.get("status");
        const list = [...quests.values()].filter((q) => !status || row(q).status === status).sort((a, b) => b.at - a.at).slice(0, limit);
        return send(res, 200, { quests: list.map((q) => row(q)), counts: counts() });
      }
      const one = p.match(/^\/quests\/([\w:-]+)$/);
      if (one) return quests.has(one[1]) ? send(res, 200, row(quests.get(one[1]), true)) : send(res, 404, { error: `no quest ${one[1]}` });
      if (p === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": mock\n\n");
        const raw = url.searchParams.get("since") ?? req.headers["last-event-id"] ?? null;
        const since = raw === null || raw === "" ? null : Number(raw);
        for (const ev of Number.isFinite(since) ? ring.filter((e) => e.n > since) : ring) res.write(`id: ${ev.n}\ndata: ${JSON.stringify(ev)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => (clearInterval(ping), clients.delete(res)));
        return;
      }
      return serveStatic(req, res, p);
    }
    if (req.method === "POST" && req.headers.origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.origin)) return send(res, 403, { error: "a POST from a page that is not on this computer is refused" });
    if (req.method === "POST" && p === "/quests") {
      const b = await body(req);
      if (!b || typeof b !== "object") return send(res, 400, { error: "the body is not a JSON object" });
      const task = typeof b.task === "string" ? b.task.trim() : "";
      if (!task) return send(res, 400, { error: "a task is needed" });
      if (b.size !== undefined && !["auto", "s", "m", "l", "small", "medium", "large"].includes(String(b.size).toLowerCase())) return send(res, 400, { error: `no size ${b.size}: auto, s or m` });
      const q = add({ task, size: b.size, by: b.by ?? null });
      waiting.push(q);
      setTimeout(pump, 50);
      return send(res, 202, { id: q.id, status: "queued", size: q.size, tier: q.tier, ...(q.downgraded ? { downgraded: q.downgraded, note: q.note } : {}) });
    }
    const stopping = req.method === "POST" && p.match(/^\/quests\/([\w:-]+)\/stop$/);
    if (stopping) {
      const q = quests.get(stopping[1]);
      if (!q) return send(res, 404, { error: `no quest ${stopping[1]}` });
      if (q.status === "queued") return stop(q), send(res, 200, { id: q.id, status: "stopped" });
      if (q.status !== "running" && q.status !== "stopping") return send(res, 200, { id: q.id, status: q.status });
      if (q.status === "running") stop(q);
      return send(res, 200, { id: q.id, status: "running", stopping: true });
    }
    send(res, 404, { error: `no route ${req.method} ${p}` });
  } catch (err) {
    send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  emit("log", { up: true, text: `mock up on http://${HOST}:${server.address().port}` });
  if (args.seed) seed();
  // the hardware is streamed live every 2 s and never kept in the ring, as the service does
  setInterval(() => {
    const block = `data: ${JSON.stringify({ t: Date.now(), type: "hardware.read", ...hardware() })}\n\n`;
    for (const res of clients) res.write(block);
  }, 2000);
  if (args.cycle) {
    const asks = [
      ["Count the open items in the notes folder and write the number to count.txt", "s"],
      ["Plan and write a short report comparing this week's support notes with last week's", "m"],
      ["Fail on purpose: read a file that is not there", "s"],
    ];
    let k = 0;
    setInterval(() => {
      if (current || waiting.length) return;
      const [task, size] = asks[k++ % asks.length];
      waiting.push(add({ task, size, by: "mock" }));
      pump();
    }, 40_000 / SPEED);
  }
  console.log(`mock: ${NAME} on http://${HOST}:${server.address().port} (pid ${process.pid})${args.seed ? ", seeded" : ""}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (dropStreams("shutdown"), server.close(), process.exit(0)));
