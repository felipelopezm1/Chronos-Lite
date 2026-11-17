// The Chronos Lite service: one node:http server on 127.0.0.1:7778
// (CHRONOS_LITE_HOST, CHRONOS_LITE_PORT) that a caller (Hephaestus, curl, the
// slim UI) hires quests from. Carried from Chronos's server and trimmed to the
// routes Lite keeps (docs/runtime-api.md has every shape):
//
//   GET  /health               who this is, the brains, the hardware, the governor, the card lock, the queue, the sizes
//   GET  /capabilities         what this edition can do (runtime/capabilities.mjs); its hash rides in /health
//   GET  /edition              the white label and the caps: {name, shortName, accent, logo, builtOn, version, caps}
//   GET  /events               the bus as SSE; ?since=<n> (or Last-Event-ID) replays from the in-memory ring, then live
//   GET  /quests               the quests this run knows, newest first, without their reports
//   POST /quests               {task, by?, size?, budget?} -> 202 {id, status, size, tier, downgraded?, note?}; the size may be
//                              the task's first line ("[size:m]"); l runs as m (runtime/sizes.mjs); an idempotency-key
//                              header makes a retry answer the same quest
//   GET  /quests/:id           one quest, with its report once it is done
//   POST /quests/:id/stop      a queued quest stops at once; a running one's workers halt between turns
//   GET  /, /<file>            the UI's static files under ui/ (index.html at /); 404 when there is no ui/
//
// Every answer but the UI's files is JSON. A POST is refused with 403 unless
// it comes from this computer (no Origin, or a localhost page): see
// trustedOrigin in bus.mjs. Bodies are capped at 1 MiB. Lite keeps no ledger
// and no history: a restart forgets its quests and its events.
//
// The work folder (CHRONOS_LITE_WORKDIR, else <home>/work) is where the trail
// is written and where the quests' file tools read and write; the code folder
// is never written by a quest unless the work folder is pointed at it.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Bus, corsHeaders, trustedOrigin } from "./bus.mjs";
import { readCommit, startBeacon } from "./beacon.mjs";
import { createCapabilities, editionCard, readEdition } from "./capabilities.mjs";
import { readCardLock } from "./cardlock.mjs";
import { cardHome, chronosHome, liteHome } from "./platform.mjs";
import { describeSizes, normalSize, parseSizeMarker, resolveTier } from "./sizes.mjs";
import { governorCan } from "./throttle.mjs";
import { createRunner } from "./quests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** where Lite listens by default: beside full Chronos on 7777 (docs/decisions/0008) */
export const DEFAULT_PORT = 7778;

/** the most a POST body may weigh */
export const BODY_MAX = 1024 * 1024;

/** how many finished quests the queue keeps in memory; older finished ones are forgotten first */
export const QUEST_KEEP = 500;

/** how many idempotency keys are remembered */
export const IDEMPOTENCY_KEEP = 1000;

/** how often the hardware sense reads the box for the bus */
const HARDWARE_MS = 2000;
/** the heat watchdog: every brain is stopped at this junction temperature, and it re-arms below REARM_C */
const CUTOFF_C = Number(process.env.CHRONOS_CUTOFF_C) || 93;
const REARM_C = 85;
/** with governed GPU brains running, the governor holds them at 92 C; the watchdog kills only at this last line */
const KILL_C = Number(process.env.CHRONOS_KILL_C) || 98;
/** consecutive hot samples (2 s apart) before the cutoff fires */
const HOT_SAMPLES = Number(process.env.CHRONOS_HOT_SAMPLES) || 2;

/** the static files' types */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** where Lite keeps its engine, brains, logs and work: CHRONOS_LITE_HOME, else ~/.chronos-lite (runtime/platform.mjs) */
export function defaultHome() {
  return liteHome();
}

/**
 * The senses and the brains, as modules: the real ones when their files are
 * there, else quiet stand-ins that say what is missing.
 */
export async function loadModules({ root = ROOT, home = defaultHome(), bus, port, lockHome = null, reuseHome = null } = {}) {
  const missing = [];
  let hardware;
  try {
    hardware = await import("./hardware.mjs");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    missing.push("hardware.mjs");
    hardware = { readHardware: () => null, fits: () => ({ ok: false, why: "hardware.mjs is missing" }), watchHardware: () => () => {} };
  }
  let brains;
  try {
    const mod = await import("./brains.mjs");
    // the port goes into the card lock, so another Chronos waiting for the card can say whose it is. Only main() names
    // lockHome (the full Chronos home, shared with every Chronos here: docs/decisions/0009); without it the lock stays
    // inside the home given, so a test never touches the real one
    // reuseHome (the full Chronos home, named by main() only) lends its engine and brains, read-only, when they are the
    // pinned ones (docs/decisions/0019); without it nothing outside the home given is read
    brains = new mod.Brains({ root, home, bus, port, reuseHome, ...(lockHome ? { cardHome: lockHome } : {}) });
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    missing.push("brains.mjs");
    const refuse = async () => {
      throw new Error("brains.mjs is missing");
    };
    brains = { list: () => [], start: refuse, stop: refuse, chat: refuse, stopAll: async () => {} };
  }
  return { hardware, brains, missing };
}

/** One JSON answer, with the CORS headers a trusted page gets. */
function json(req, res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

/** Read a POST body as JSON; rejects past BODY_MAX or when it is not JSON. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error("the body is over 1 MiB"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error("the body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** A quest id: q-<time in base36><two random base36 digits>. */
function questId() {
  return `q-${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

const FINISHED = new Set(["done", "partial", "blocked", "failed", "stopped"]);

/**
 * The queue of quests: taken in and announced here; the runner
 * (runtime/quests.mjs) takes them with next(), oldest first, one at a time.
 * A quest is stamped with its size and tier when it is accepted (the runner
 * resolves them again when it takes it). `resolve({asked, task, brain})`
 * answers runtime/sizes.mjs' resolveTier for this server's brains. Lite keeps
 * quests in memory only: past `keep` the oldest finished ones are forgotten.
 */
export function createQueue(bus, { resolve = null, keep = QUEST_KEEP } = {}) {
  const quests = new Map();

  function forget() {
    if (quests.size <= keep) return;
    for (const [id, q] of quests) {
      if (quests.size <= keep) break;
      if (FINISHED.has(q.status)) quests.delete(id);
    }
  }

  function add({ task, by = null, size = null, brain = null, budget = null }) {
    let id = questId();
    while (quests.has(id)) id = questId();
    // the size: asked for outright, else named in the task's first line ("[size:m]"), else auto; the marker never stays
    const marked = parseSizeMarker(task);
    const named = typeof size === "string" ? normalSize(size) : null;
    const asked = named && named !== "auto" ? named : (marked.size ?? "auto");
    task = marked.task || String(task ?? "").trim();
    const r = resolve ? resolve({ asked, task, brain }) : resolveTier({ asked, task, brain });
    const q = {
      id,
      task,
      by,
      status: "queued",
      at: Date.now(),
      size: r.size,
      tier: r.tier,
      asked,
      ...(r.downgraded ? { downgraded: r.downgraded, note: r.notes?.[0] ?? null } : {}),
      ...(brain ? { brain } : {}),
      ...(budget ? { budget } : {}),
    };
    quests.set(id, q);
    forget();
    bus.emit("quest.queued", { id, task, by, size: q.size, tier: q.tier, ...(q.downgraded ? { downgraded: q.downgraded } : {}) });
    // the event of before sizes, at the same moment: Hephaestus's wisp driver follows it
    bus.emit("quest.started", { id, task, by });
    return q;
  }

  const counts = () => {
    let queued = 0;
    let running = 0;
    for (const q of quests.values()) {
      if (q.status === "queued") queued++;
      if (q.status === "running") running++;
    }
    return { queued, running };
  };

  /** the oldest quest still queued, or null */
  const next = () => {
    for (const q of quests.values()) if (q.status === "queued") return q;
    return null;
  };

  return { quests, add, next, counts, list: () => [...quests.values()], get: (id) => quests.get(id) ?? null };
}

/** A quest as GET /quests lists it: everything but its report. */
export function questRow(q) {
  const { report, ...row } = q;
  return { ...row, ...(report ? { summary: q.summary ?? report.summary ?? "" } : {}) };
}

/**
 * The static UI under dir: GET and HEAD only, index.html at /, the type by
 * the extension, never a file outside dir. Answers true when it answered.
 */
export function serveStatic(req, res, dir, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!dir || !fs.existsSync(dir)) return false;
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes("\0")) return false;
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";
  const base = path.resolve(dir);
  const file = path.resolve(base, `.${path.posix.normalize(rel)}`);
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": stat.size, "cache-control": "no-cache" });
  if (req.method === "HEAD") return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * The HTTP server, not yet listening. Tests start it on port 0 with stand-in
 * brains and hardware; main() starts it with the real ones and the beacon.
 * `home` is Lite's own; `lockHome` is where the card lock is read for /health
 * (the full Chronos home in main(); the home itself when a test names only it).
 */
export function createServer({ root = ROOT, home = null, lockHome = null, port = DEFAULT_PORT, host = "127.0.0.1", bus = new Bus(), brains, hardware, missing = [], runner = null, tiers = runner?.tiers ?? brains?.catalogue?.tiers ?? null, workdir = null, uiDir = path.join(root, "ui"), info = readEdition(root) } = {}) {
  const work = workdir ? path.resolve(workdir) : root;
  const allBrains = () => brains?.list?.() ?? [];
  const regularBrains = () => allBrains().filter((b) => !b.alternate);
  const sizeOf = ({ asked, task, brain }) => resolveTier({ asked, task, tiers, list: regularBrains(), brain });
  const queue = createQueue(bus, { resolve: sizeOf });
  /** idempotency key -> quest id, the newest IDEMPOTENCY_KEEP */
  const idempotency = new Map();
  const commit = readCommit(root);
  const readHardware = () => hardware?.readHardware?.() ?? null;
  const name = info.brand.name ?? "Chronos Lite";
  let governorHere = null;
  const governorNow = () => brains?.governorStatus?.() ?? (governorHere ??= governorCan());
  const cardNow = () => {
    if (brains?.cardStatus) return brains.cardStatus();
    try {
      return { lock: readCardLock(lockHome ?? home ?? cardHome()), mine: false };
    } catch {
      return { lock: null, mine: false };
    }
  };

  // The heat watchdog, as in full Chronos: the laptop this was built on powers off at 100 C junction, so every
  // brain is stopped after HOT_SAMPLES consecutive readings at the line, never on one spike, and it re-arms under 85 C.
  let tripped = false;
  let hotRun = 0;
  const onHeat = async (hw) => {
    const j = hw?.heat?.junctionC;
    if (!Number.isFinite(j)) return;
    const line = brains?.governing ? KILL_C : CUTOFF_C;
    hotRun = j >= line ? hotRun + 1 : 0;
    if (!tripped && hotRun >= HOT_SAMPLES) {
      tripped = true;
      bus.emit("heat.cutoff", { junctionC: j, cutoffC: line, text: `GPU junction at ${j} C: every brain is stopped before the firmware powers the machine off` });
      try {
        await brains?.stopAll?.();
      } catch (err) {
        bus.emit("log", { text: `heat cutoff: a brain would not stop: ${err?.message ?? err}` });
      }
    } else if (tripped && j < REARM_C) {
      tripped = false;
      bus.emit("heat.clear", { junctionC: j, text: `GPU junction back at ${j} C: brains may start again` });
    }
  };
  bus.on("hardware.read", onHeat);

  const caps = createCapabilities({ root, commit, port: () => listening()?.port ?? port, brains, tiers, card: () => cardNow(), governor: () => governorNow(), info });

  // the hash is asked for by every GET /health and every beat of the beacon: worked out at most every 2 s
  let hashAt = 0;
  let hashNow = null;
  const capsHash = () => {
    if (!hashNow || Date.now() - hashAt > 2000) {
      try {
        hashNow = caps.hash();
      } catch {
        hashNow = null;
      }
      hashAt = Date.now();
    }
    return hashNow;
  };

  const brainSummary = () => regularBrains().map((b) => ({ id: b.id, role: b.role, status: b.status, slot: b.slot ?? null, present: b.present !== false, where: b.where ?? null }));

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${port}`);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      if (!trustedOrigin(req)) return json(req, res, 403, { error: "only this computer may talk to Chronos Lite" });
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (p === "/health") {
        return json(req, res, 200, {
          ok: true,
          // kind chronos, so a caller written for Chronos (Hephaestus's wisp driver) hires Lite unchanged; edition says which
          kind: "chronos",
          edition: "lite",
          name,
          builtOn: info.brand.builtOn ?? "built on Chronos",
          version: info.version,
          cwd: work,
          code: root,
          port: listening()?.port ?? port,
          commit,
          brains: brainSummary(),
          hardware: readHardware(),
          governor: governorNow(),
          card: cardNow(),
          quests: queue.counts(),
          sizes: describeSizes({ tiers, list: regularBrains() }),
          capabilities: { hash: capsHash(), url: "/capabilities" },
          ...(missing.length ? { missing } : {}),
        });
      }
      if (p === "/capabilities") return json(req, res, 200, caps.manifest());
      if (p === "/edition") return json(req, res, 200, editionCard(info));
      if (p === "/events") return bus.sse(req, res);
      if (p === "/quests") {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const status = url.searchParams.get("status");
        const rows = queue
          .list()
          .filter((q) => !status || q.status === status)
          .reverse()
          .slice(0, limit)
          .map(questRow);
        return json(req, res, 200, { quests: rows, counts: queue.counts() });
      }
      const quest = p.match(/^\/quests\/([\w-]+)$/);
      if (quest) {
        const q = queue.get(quest[1]);
        return q ? json(req, res, 200, q) : json(req, res, 404, { error: `no quest ${quest[1]}` });
      }
      if (serveStatic(req, res, uiDir, p)) return;
      return json(req, res, 404, { error: p === "/" ? "this Chronos Lite has no UI (no ui/ folder)" : `no route ${req.method} ${p}` });
    }

    if (req.method !== "POST") return json(req, res, 404, { error: `no route ${req.method} ${p}` });
    if (!trustedOrigin(req)) return json(req, res, 403, { error: "only this computer may talk to Chronos Lite" });

    let b;
    try {
      b = await readBody(req);
    } catch (err) {
      return json(req, res, err.status ?? 400, { error: err.message });
    }

    if (p === "/quests") {
      const task = String(b.task ?? "").trim();
      // a task that is only a size marker is no task
      if (!parseSizeMarker(task).task) return json(req, res, 400, { error: "a quest needs a task" });
      if (b.size != null && !normalSize(b.size)) return json(req, res, 400, { error: `no size ${JSON.stringify(b.size)}: a quest is auto, s or m (an l runs as m)` });
      if (b.brain != null && !regularBrains().some((x) => x.id === b.brain)) return json(req, res, 400, { error: `no brain ${JSON.stringify(b.brain)} to take the Titan's seat` });
      let budget = null;
      if (b.budget != null) {
        const ok = typeof b.budget === "object" && !Array.isArray(b.budget) && ["tokens", "seconds"].every((k) => b.budget[k] == null || (typeof b.budget[k] === "number" && Number.isFinite(b.budget[k]) && b.budget[k] > 0));
        if (!ok) return json(req, res, 400, { error: "a budget is {tokens?, seconds?}, each a number above 0" });
        budget = { ...(b.budget.tokens != null ? { tokens: b.budget.tokens } : {}), ...(b.budget.seconds != null ? { seconds: b.budget.seconds } : {}) };
        if (!Object.keys(budget).length) budget = null;
      }
      // a caller that retries with the same idempotency key gets the quest it already made
      const idem = String(req.headers["idempotency-key"] ?? b.idempotencyKey ?? "").trim().slice(0, 200);
      const before = idem && idempotency.has(idem) ? queue.get(idempotency.get(idem)) : null;
      if (before) return json(req, res, 202, { id: before.id, status: before.status, size: before.size, tier: before.tier, duplicate: true });
      const q = queue.add({ task, by: b.by ?? null, size: b.size ?? null, brain: b.brain ?? null, budget });
      if (idem) {
        idempotency.set(idem, q.id);
        if (idempotency.size > IDEMPOTENCY_KEEP) idempotency.delete(idempotency.keys().next().value);
      }
      return json(req, res, 202, { id: q.id, status: q.status, size: q.size, tier: q.tier, ...(q.downgraded ? { downgraded: q.downgraded, note: q.note } : {}) });
    }

    const stopQuest = p.match(/^\/quests\/([\w-]+)\/stop$/);
    if (stopQuest) {
      const q = queue.get(stopQuest[1]);
      if (!q) return json(req, res, 404, { error: `no quest ${stopQuest[1]}` });
      if (q.status === "queued") {
        q.status = "stopped";
        q.stop = true;
        bus.emit("quest.done", { id: q.id, status: "stopped", size: q.size, tier: q.tier, summary: "stopped before it started" });
        return json(req, res, 200, { id: q.id, status: q.status });
      }
      if (q.status !== "running") return json(req, res, 200, { id: q.id, status: q.status });
      if (!runner?.stop) return json(req, res, 409, { error: "no runner to stop" });
      q.stop = true;
      runner.stop(q.id);
      return json(req, res, 200, { id: q.id, status: q.status, stopping: true });
    }

    return json(req, res, 404, { error: `no route ${req.method} ${p}` });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      bus.emit("log", { level: "error", text: `${req.method} ${req.url}: ${err?.message ?? err}` });
      if (!res.headersSent) json(req, res, 500, { error: err?.message ?? String(err) });
      else res.end();
    });
  });
  const listening = () => (server.listening ? server.address() : null);

  /** Listen; resolves with the port in use (useful when 0 was asked for). */
  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        runner?.start?.(queue);
        resolve(server.address().port);
      });
    });
  }

  async function close() {
    await runner?.close?.();
    bus.off?.("hardware.read", onHeat);
    bus.closeAll();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(() => r()));
  }

  return { server, bus, queue, brains, hardware, runner, capabilities: caps, listen, close, url: () => `http://${host}:${listening()?.port ?? port}` };
}

/** Stop the runtime: close the server, then stop the brains, then exit. */
export async function shutdownRuntime({ app, brains, stopHardware = () => {}, beacon = null, sig = "shutdown", exit = (code) => process.exit(code), log = console.log } = {}) {
  log?.(`chronos-lite stopping (${sig})`);
  app?.bus?.emit?.("log", { down: true, why: sig, text: `chronos-lite stopping (${sig})` });
  stopHardware?.();
  beacon?.stop?.();
  try {
    await app?.close?.();
  } finally {
    try {
      await brains?.stopAll?.();
    } catch {
      /* a brain that would not stop is a child: it dies with us */
    }
  }
  exit?.(0);
}

/** Start everything: the bus, the senses, the brains, the runner, the server, the beacon. */
export async function main() {
  const host = process.env.CHRONOS_LITE_HOST || "127.0.0.1";
  const port = Number(process.env.CHRONOS_LITE_PORT) || DEFAULT_PORT;
  const home = defaultHome();
  const lockHome = cardHome();
  // CHRONOS_LITE_REUSE=0 turns reuse off: then only Lite's own home is read
  const reuseHome = process.env.CHRONOS_LITE_REUSE === "0" ? null : chronosHome();
  const bus = new Bus();
  const { hardware, brains, missing } = await loadModules({ root: ROOT, home, bus, port, lockHome, reuseHome });
  const workdir = path.resolve(process.env.CHRONOS_LITE_WORKDIR || path.join(home, "work"));
  fs.mkdirSync(workdir, { recursive: true });
  const runner = createRunner({ root: workdir, brains, hardware, bus });
  const app = createServer({ root: ROOT, home, lockHome, port, host, bus, brains, hardware, missing, runner, workdir });
  const stopHardware = hardware.watchHardware(bus, HARDWARE_MS);
  await app.listen();
  // kind chronos-lite: a reader looking for full Chronos never picks this one by mistake (docs/decisions/0012)
  const beacon = startBeacon({ port, root: ROOT, id: "chronos-lite", name: readEdition(ROOT).brand.name ?? "Chronos Lite", kind: "chronos-lite", host, extra: () => ({ edition: "lite", capabilities: app.capabilities.hash(), capabilitiesUrl: "/capabilities" }) });
  console.log(`chronos-lite listening on ${app.url()}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
  bus.emit("log", { up: true, pid: process.pid, port, commit: readCommit(ROOT), text: `chronos-lite up on ${app.url()}` });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    await shutdownRuntime({ app, brains, stopHardware, beacon, sig });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
