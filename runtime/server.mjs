// The Chronos service: one node:http server on 127.0.0.1:7777 (CHRONOS_HOST,
// CHRONOS_PORT) that Hephaestus, the CLI and the UI all talk to.
//
//   GET  /health                 who this is, the brains, the hardware, the queue, and governor {runs, why}: whether GPU
//                                brains run under the heat governor here (only with a junction to read and a way to pause);
//                                card {lock, mine}: the card lock every Chronos here shares (runtime/cardlock.mjs)
//   GET  /events                 the bus as SSE: history, then live (runtime/bus.mjs)
//   GET  /hardware               the hardware sense right now
//   GET  /brains                 every brain with its status and slot
//   POST /brains/:id/start       start one; POST /brains/:id/stop; POST /brains/switch {slot, id}
//   POST /chat                   {brain?|slot?, messages, thinking?, maxTokens?} -> the brain's answer
//   GET  /capabilities           everything this Chronos is and can do, in one manifest for Hephaestus: routes, brains,
//                                sizes, Prometheans, media kinds, the bridge (runtime/capabilities.mjs); its hash rides in
//                                /health and in the beacon, so a reader fetches it again only when it changed
//   POST /quests                 {task, by?, size?, brain?, budget?, attachments?} -> 202 {id, status, size, tier}; the size
//                                may also be the task's first line ("[size:l]"); size picks the brains (runtime/sizes.mjs);
//                                attachments are media ids whose text the quest reads; an idempotency-key header makes a
//                                retry answer the same quest
//   GET  /quests                 ?limit&before=<id>&status -> newest first, without reports, finished ones from before a
//                                restart too (runtime/history.mjs); GET /quests/:id (status and report)
//   POST /quests/:id/stop        raise the stop flag; the workers halt between turns
//   POST /bridge/arrive          an envoy from another city (Hephaestus's bridge.mjs shape), attachments? taken into the
//                                media store; its answer goes home at quest.done, kept in an outbox until it is taken
//   POST /bridge/answer          {id, key, ok, text, media?} the answer of an envoy Chronos sent out (runtime/bridge.mjs)
//   POST /envoys                 {to, ask, by?, attachments?} -> 202 {id, to}: send an envoy to another city on this computer
//   GET  /events?since=<n>       replay what came after n (from the ledger, then the history), then live
//   GET  /log                    ?day&before&limit&type&quest&chat&q -> {events newest first, next, day} (runtime/ledger.mjs)
//   GET  /log/days               [{day, count, quests, firstT, lastT}], newest first
//   GET  /trail                  the chained trail entries, newest first; /trail/verify; /trail/:name with its markdown
//   GET  /link                   the connection to Hephaestus: the beacon, the cities, envoys pending and recent, hires
//   GET  /heph/quests            ?days&limit -> Hephaestus's quests in this city, newest first, folded from its brain/webs
//                                (runtime/heph.mjs); GET /heph/quests/:id one with its steps, tasks, spiders and files
//   GET  /chats                  the stored conversations; POST /chats {title?, brain?|slot?} -> {id} (runtime/chats.mjs)
//   GET  /chats/:id              one with its messages; PATCH {title?, brain?, slot?}; DELETE moves it to the attic
//   POST /chats/:id/messages     {content, attachments?, thinking?, brain?, maxTokens?} -> 202 {id}; the answer streams as
//                                chat.* events; a vision brain sees the attached pictures, every brain reads their text
//   POST /chats/:id/stop         stop the answer; POST /chats/:id/quest {task?, size?} hires a quest from the conversation
//   GET  /setup                  the machine, the engine, the brains with what fits, the three sets, the downloads (runtime/setup.mjs)
//   POST /setup/download         {engine?, brains?, set?} -> 202 {downloads: [ids]}; POST /setup/cancel {id}; 409 with needMiB and
//                                freeMiB when the disk is too small. Nothing is downloaded without this call.
//   POST /shutdown               stop the brains, remove the beacon and exit (202, then it goes): for a desktop app on
//                                Windows, where a child cannot be sent SIGTERM
//   GET  / and /ui/*             the UI: static files under ui/ (runtime/ui.mjs)
//
// /media and /media/:id with /raw, /text and /thumb are the attachments, documented in runtime/media.mjs: a POST
// there carries the file itself, so it is read by media.mjs up to its own size cap, not the 1 MiB below.
//
// Every answer is JSON. A POST is refused with 403 unless it comes from this
// computer (no Origin, or a localhost page): see trustedOrigin in bus.mjs.
// Bodies are capped at 1 MiB. A refusal from the brains (will not fit, not
// downloaded, already loading) is a 409 with the reason.
//
// The work folder (CHRONOS_WORKDIR, or createServer's workdir) is where the trail is written and where the quests'
// file tools read and write, apart from the code: when it is not set, both are the code folder, as before. The UI
// and the catalogue always come from the code folder. GET /health says both: cwd (the work folder) and code.
//
// hardware.mjs and brains.mjs are loaded when the server starts; when one is
// missing (it is being written) the server still runs and /health says so.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Bus, corsHeaders, trustedOrigin } from "./bus.mjs";
import { defaultDir as beaconDir, readCommit, startBeacon } from "./beacon.mjs";
import { allCities, createBridge } from "./bridge.mjs";
import { createCapabilities } from "./capabilities.mjs";
import { createChats } from "./chats.mjs";
import { LIST_LIMIT_MAX, createHistory, pageQuests } from "./history.mjs";
import { createLedger } from "./ledger.mjs";
import { readCardLock } from "./cardlock.mjs";
import { createMedia, isLoopback, send as sendMedia, textOfParts } from "./media.mjs";
import { chronosHome } from "./platform.mjs";
import { describeSizes, isHire, normalSize, parseSizeMarker, resolveTier } from "./sizes.mjs";
import { governorCan } from "./throttle.mjs";
import { entryRow, readChain, trailDir, verifyChain } from "./trail.mjs";
import { createRunner } from "./quests.mjs";
import { createSetup } from "./setup.mjs";
import { createHeph } from "./heph.mjs";
import { isUiPath, serveUi } from "./ui.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** the most a POST body may weigh */
export const BODY_MAX = 1024 * 1024;

/** how often the hardware sense reads the box for the bus */
const HARDWARE_MS = 2000;
/** the heat watchdog: every brain is stopped at this junction temperature, and it re-arms below REARM_C */
const CUTOFF_C = Number(process.env.CHRONOS_CUTOFF_C) || 93;
const REARM_C = 85;
/** with governed GPU brains running, the governor holds them at 92 C; the watchdog kills only at this last line (CHRONOS_KILL_C) */
const KILL_C = Number(process.env.CHRONOS_KILL_C) || 98;
/** consecutive hot samples (2 s apart) before the cutoff fires */
const HOT_SAMPLES = Number(process.env.CHRONOS_HOT_SAMPLES) || 2;

/** why a list of attachments is refused, or null: at most 16 media ids */
function badAttachments(list) {
  if (list == null) return null;
  if (!Array.isArray(list) || list.length > 16 || !list.every((a) => typeof a === "string" && /^m-[a-z0-9]{6,24}$/.test(a))) return "attachments are a list of at most 16 media ids (m-...), from POST /media";
  return null;
}

/** where Chronos keeps its models and engine: CHRONOS_HOME, else ~/.chronos, %LOCALAPPDATA%\Chronos on Windows (runtime/platform.mjs) */
export function defaultHome() {
  return chronosHome();
}

/**
 * The senses and the brains, as modules: the real ones when their files are
 * there, else quiet stand-ins that say what is missing.
 */
export async function loadModules({ root = ROOT, home = defaultHome(), bus, port } = {}) {
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
    // the port goes into the card lock, so another Chronos waiting for the card can say whose it is
    brains = new mod.Brains({ root, home, bus, port });
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    missing.push("brains.mjs");
    const refuse = async () => {
      throw new Error("brains.mjs is missing");
    };
    brains = { list: () => [], start: refuse, stop: refuse, switchSlot: refuse, chat: refuse, stopAll: async () => {} };
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

/**
 * The queue of quests: taken in and announced here; the runner
 * (runtime/quests.mjs) takes them with next(), oldest first, one at a time.
 *
 * A quest is stamped with its size and tier when it is accepted (the runner
 * resolves them again when it takes it). `resolve({asked, task, brain})`
 * answers runtime/sizes.mjs' resolveTier for this server's brains; without it
 * every quest is m. `known(id)` says an id is already taken elsewhere (the
 * history of finished quests).
 */
export function createQueue(bus, { resolve = null, known = null, media = null } = {}) {
  const quests = new Map();
  /** envoy keys, kept apart so a GET never shows one */
  const keys = new Map();

  function add({ task, by = null, tag = null, envoy = null, key = null, size = null, brain = null, budget = null, chat = null, attachments = null }) {
    let id = questId();
    while (quests.has(id) || known?.(id)) id = questId();
    // the size: asked for outright, else named in the task's first line ("[size:l]"), else auto; the marker never stays in the task
    const marked = parseSizeMarker(task);
    const named = typeof size === "string" ? normalSize(size) : null;
    const asked = named && named !== "auto" ? named : (marked.size ?? "auto");
    task = marked.task || String(task ?? "").trim();
    const r = resolve ? resolve({ asked, task, brain }) : resolveTier({ asked, task, brain });
    // attachments: media ids kept here; their text (and what a picture is) rides on the quest as `attached`, which the
    // Titan's plan and a size-s worker read after the task (runtime/quests.mjs questAsk)
    const media_ = typeof media === "function" ? media() : media;
    const ids = Array.isArray(attachments) ? [...new Set(attachments.filter((a) => typeof a === "string" && (media_?.has?.(a) ?? false)))].slice(0, 16) : [];
    const attached = ids.length && media_?.toBrainParts ? attachedText(media_, ids) : "";
    const q = { id, task, by, status: "queued", at: Date.now(), size: r.size, tier: r.tier, asked, ...(brain ? { brain } : {}), ...(budget ? { budget } : {}), ...(tag ? { tag } : {}), ...(envoy ? { envoy } : {}), ...(chat ? { chat } : {}), ...(ids.length ? { attachments: ids } : {}), ...(attached ? { attached } : {}) };
    quests.set(id, q);
    if (key) keys.set(id, key);
    const said = { id, task, by, ...(tag ? { tag } : {}), ...(envoy ? { envoy } : {}), ...(ids.length ? { attachments: ids } : {}) };
    bus.emit("quest.queued", { ...said, size: q.size, tier: q.tier, ...(chat ? { chat } : {}) });
    // the event of before sizes, at the same moment: Hephaestus's wisp driver follows it
    bus.emit("quest.started", said);
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

  return { quests, keys, add, next, counts, list: () => [...quests.values()], get: (id) => quests.get(id) ?? null };
}

/** what a quest reads of its attachments: their text and what each is, with the address of its bytes, at most 12 000 characters */
export function attachedText(media, ids, { budget = 12_000 } = {}) {
  try {
    const parts = media.toBrainParts(ids, { vision: false, budget });
    const where = ids.map((id) => media.get?.(id)).filter(Boolean).map((m) => `- ${m.name} (${m.kind}): GET /media/${m.id}/raw`);
    return `${textOfParts(parts)}${where.length ? `\n\nThe files themselves:\n${where.join("\n")}` : ""}`.trim();
  } catch {
    return "";
  }
}

/**
 * The HTTP server, not yet listening. Tests start it on port 0 with stand-in
 * brains and hardware; main() starts it with the real ones and the beacon.
 */
export function createServer({ root = ROOT, home = defaultHome(), port = 7777, host = "127.0.0.1", bus = new Bus(), brains, hardware, missing = [], name = "Chronos", runner = null, runtimesDir, bridgeOptions = {}, ledger = bus.ledger ?? null, history = null, tiers = runner?.tiers ?? brains?.catalogue?.tiers ?? null, setup = undefined, workdir = null, onShutdown = null, heph = undefined, media = undefined } = {}) {
  // the work folder: where the trail lives and the quests work; the code folder when none is named
  const work = workdir ? path.resolve(workdir) : root;
  // Hephaestus's quests in this city (runtime/heph.mjs): read only when asked, from the code folder's brain/webs, the
  // checkout it hangs off, the work folder's and the city's own; null turns the routes off
  const hephStore = heph !== undefined ? heph : createHeph({ root, workdir: workdir ? work : null, ...(runtimesDir ? { runtimesDir } : {}) });
  // Finished quests outlive a restart under the home the caller names (main() names it). A server made
  // without one keeps them in memory, so a test never writes into the owner's own ~/.chronos.
  const past = history ?? createHistory({ home: arguments[0]?.home ?? null });
  const allBrains = () => brains?.list?.() ?? [];
  const regularBrains = () => allBrains().filter((b) => !b.alternate);
  /** the size and tier a quest resolves to with this server's brains (runtime/sizes.mjs) */
  const sizeOf = ({ asked, task, brain }) => resolveTier({ asked, task, tiers, list: regularBrains(), brain });
  // the attachments (runtime/media.mjs): under the home the caller names; a server made without one keeps them in a temp
  // folder of its own, removed at close, so a test never writes into the owner's own ~/.chronos; null turns them off
  const ownHome = arguments[0]?.home ?? null;
  let mediaTmp = null;
  if (media === undefined && !ownHome) mediaTmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-media-"));
  const store = media !== undefined ? media : createMedia({ ...(ownHome ? { home: ownHome } : { dir: mediaTmp }), bus });
  const queue = createQueue(bus, { resolve: sizeOf, known: (id) => past.has(id), media: store });
  // a finished quest is kept the moment it ends (the runner fills the queue's own copy just after)
  const keep = (e) => {
    const q = queue.get(e?.id);
    if (!q) return;
    try {
      past.add({ ...q, status: e.status ?? q.status, ...(e.size ? { size: e.size } : {}), ...(e.tier ? { tier: e.tier } : {}), summary: e.report?.summary ?? e.summary ?? q.summary ?? "", ...(e.why ? { why: e.why } : {}), ...(e.report ? { report: e.report } : {}), doneAt: Date.now() });
    } catch (err) {
      bus.emit("log", { level: "error", quest: q.id, text: `the history could not keep quest ${q.id}: ${err?.message ?? err}` });
    }
  };
  bus.on("quest.done", keep);
  /** every quest this server knows: the queue's, then the finished ones of earlier runs; rows only where they come from the history */
  const everyQuest = () => {
    const live = queue.list();
    const seen = new Set(live.map((q) => q.id));
    return [...live, ...past.rows().filter((q) => !seen.has(q.id))];
  };
  // envoys: the answer home at quest.done, and envoys out to the other cities
  // the outbox of answers home lives under the home the caller names (in memory without one); the quests' files are
  // found in the work folder; attachments go through the media store, and Hephaestus's arms read what Chronos cannot
  const bridge = createBridge({ bus, queue, port: () => listening()?.port ?? port, home: ownHome, work, root, ...(runtimesDir ? { dir: runtimesDir } : {}), ...bridgeOptions });
  if (store) bridge.attachMedia(store);
  // the conversations behind the UI's tabs: stored under <home>/chats, answered on the bus
  const chats = createChats({ home, bus, brains, queue, media: store, pick: (want) => pickBrain(want) });
  const isChats = (p) => p === "/chats" || p.startsWith("/chats/");
  const commit = readCommit(root);
  const readHardware = () => hardware?.readHardware?.() ?? null;
  // Setup (the engine and the models) writes under the home the caller names (main() names it). A server made
  // without one has no /setup, so a test never downloads into the owner's own home; null turns it off outright.
  // (nor has one whose code folder carries no catalogue to set up from)
  const hasCatalogue = !!brains?.catalogue || fs.existsSync(path.join(root, "forge", "brains.json"));
  const setups = setup !== undefined ? setup : arguments[0]?.home && hasCatalogue ? createSetup({ home, root, catalogue: brains?.catalogue ?? null, bus, readHardware }) : null;
  const noSetup = { error: "this runtime has no setup: it was started without a home to download into, or without a catalogue" };
  // whether GPU brains run under the governor here: the brains' own word, else what this system can do (docs/ui-contract.md 2.6)
  let governorHere = null;
  const governorNow = () => brains?.governorStatus?.() ?? (governorHere ??= governorCan());
  const cardNow = () => {
    if (brains?.cardStatus) return brains.cardStatus();
    try {
      return { lock: readCardLock(home), mine: false };
    } catch {
      return { lock: null, mine: false };
    }
  };

  // The heat watchdog. This laptop's firmware powers the whole machine off at
  // 100 C junction (twice on 2026-10-20 and 21, mid-quest). fits() refuses new
  // GPU work at 90 C; this stops the brains that are already running at 93 C,
  // so the card cools before the firmware acts, and re-arms once it is under 85 C.
  // Loading a model into VRAM spikes the junction sensor to 100 C and more for
  // a single sample while the edge sits at 65 C (seen 2026-10-21 20:33, five
  // times in a minute); a real climb lasts. So the cutoff needs HOT_SAMPLES
  // consecutive readings at or above CUTOFF_C, never one spike.
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

  // the manifest of everything this Chronos is (GET /capabilities), built from the live parts each time it is asked
  const caps = createCapabilities({
    root,
    work,
    name,
    commit,
    port: () => listening()?.port ?? port,
    brains,
    runner,
    tiers,
    queue,
    history: past,
    chats,
    ledger,
    setup: setups,
    bridge,
    bus,
    missing,
    media: () => store,
    governor: () => governorNow(),
    card: () => cardNow(),
    hardware: () => readHardware(),
  });

  /** why attachments name media this runtime does not keep, or null */
  const missingAttachment = (list) => {
    if (!Array.isArray(list) || !list.length) return null;
    if (!store) return "this runtime keeps no attachments";
    const gone = list.filter((id) => !store.has(id));
    return gone.length ? `no attachment ${gone.join(", ")}: send the file to POST /media first` : null;
  };

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

  /** the brains as /health shows them: id, role, status, slot */
  const brainSummary = () => regularBrains().map((b) => ({ id: b.id, role: b.role, status: b.status, slot: b.slot ?? null }));

  /** the brain a chat goes to: by id, else by slot (talk by default) */
  function pickBrain({ brain, slot }) {
    const all = allBrains();
    if (brain) return all.find((b) => b.id === brain) ?? null;
    const s = slot || "talk";
    const regular = all.filter((b) => !b.alternate);
    return regular.find((b) => b.slot === s) ?? regular.find((b) => b.role === s) ?? null;
  }

  /** GET /link: the connection to Hephaestus in one read (docs/ui-contract.md 2.5); never a key */
  function linkNow() {
    const now = Date.now();
    const myPort = listening()?.port ?? port;
    const dir = runtimesDir ?? beaconDir();
    const file = path.join(dir, `${myPort}.json`);
    let beacon = { path: file, writtenAt: null, port: myPort, kind: "chronos" };
    try {
      const b = JSON.parse(fs.readFileSync(file, "utf8"));
      beacon = { path: file, writtenAt: Number(b.beat) || null, port: Number(b.port) || myPort, kind: b.kind ?? "chronos" };
    } catch {
      /* no beacon yet: a test, or the first moments of a start */
    }
    const cities = allCities({ dir, now })
      .filter((c) => Number(c.port) !== Number(myPort))
      .map((c) => ({ id: String(c.id ?? c.port), name: String(c.name ?? c.id ?? c.port), port: Number(c.port), kind: c.kind ?? "hephaestus", live: c.live, commit: typeof c.commit === "string" ? c.commit.slice(0, 7) : null, root: c.root ?? null, here: !!c.root && path.resolve(String(c.root)) === path.resolve(root), beat: Number(c.beat) || null }));
    const open = new Set(["queued", "running"]);
    const pending = [
      ...queue
        .list()
        .filter((q) => q.envoy && open.has(q.status))
        .map((q) => ({ id: q.envoy.id, dir: "in", from: q.envoy.from, ask: q.task, at: q.at, quest: q.id })),
      ...bridge.pending().map((e) => ({ id: e.id, dir: "out", to: e.to, ask: e.ask, at: e.sentAt })),
    ].sort((a, b) => b.at - a.at);
    const recent = ledger ? ledger.read({ day: "all", types: ["envoy."], limit: 50 }).events : bus.history.filter((e) => String(e.type).startsWith("envoy.")).slice(-50).reverse();
    // hires survive a restart: the finished ones come back from the history
    const hired = everyQuest().filter(isHire).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const bySize = { s: 0, m: 0, l: 0 };
    for (const q of hired) bySize[q.size ?? "m"] = (bySize[q.size ?? "m"] ?? 0) + 1;
    const last = hired.slice(0, 8).map((q) => ({ id: q.id, task: q.task, by: q.by ?? null, size: q.size ?? "m", status: q.status, at: q.at, ...(q.tag ? { tag: q.tag } : {}), ...(q.envoy ? { envoy: { id: q.envoy.id, from: q.envoy.from } } : {}) }));
    return { beacon, cities, pending, recent, hires: { total: hired.length, bySize, last } };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${port}`);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      if (!trustedOrigin(req)) return json(req, res, 403, { error: "only this computer may talk to Chronos" });
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    // the UI: GET and HEAD, so curl -I on a file works the way ui.mjs allows
    if ((req.method === "GET" || req.method === "HEAD") && isUiPath(p)) return serveUi(req, res);

    // the attachments (runtime/media.mjs): a POST carries the file itself, read there up to its own cap
    if (p === "/media" || p.startsWith("/media/")) {
      if (!store) return json(req, res, 404, { error: "this runtime keeps no attachments" });
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return json(req, res, 404, { error: `no route ${req.method} ${p}` });
      if (req.method === "POST" && !trustedOrigin(req)) return json(req, res, 403, { error: "only this computer may talk to Chronos" });
      return sendMedia(req, res, await store.route(req.method, p, null, req), corsHeaders(req));
    }
    if (req.method === "GET" && p === "/capabilities") return json(req, res, 200, await caps.manifest());

    if (req.method === "GET") {
      if (p === "/health") {
        return json(req, res, 200, {
          ok: true,
          kind: "chronos",
          name,
          cwd: work,
          code: root,
          port: listening()?.port ?? port,
          commit,
          brains: brainSummary(),
          hardware: readHardware(),
          governor: governorNow(),
          // the card lock, read from disk each time: which Chronos holds the GPU card, and whether it is this one
          card: cardNow(),
          quests: queue.counts(),
          sizes: describeSizes({ tiers, list: regularBrains() }),
          // the link to Hephaestus and the outbox of answers home (never a key); the hash of GET /capabilities
          bridge: bridge.link(),
          capabilities: { hash: capsHash(), url: "/capabilities" },
          ...(missing.length ? { missing } : {}),
        });
      }
      if (p === "/events") return bus.sse(req, res);
      if (p === "/hardware") return json(req, res, 200, readHardware());
      if (p === "/brains") return json(req, res, 200, brains.list());
      if (p === "/quests") {
        const q = url.searchParams;
        return json(req, res, 200, pageQuests(everyQuest(), { limit: q.get("limit") || LIST_LIMIT_MAX, before: q.get("before"), status: q.get("status") }));
      }
      if (p === "/log") {
        if (!ledger) return json(req, res, 200, { events: [], next: null, day: url.searchParams.get("day") || null });
        const q = url.searchParams;
        return json(req, res, 200, ledger.read({ day: q.get("day"), before: q.get("before"), limit: q.get("limit") || 100, types: q.get("type") || "", quest: q.get("quest"), chat: q.get("chat"), q: q.get("q") || "" }));
      }
      if (p === "/log/days") return json(req, res, 200, ledger ? ledger.days() : []);
      if (p === "/trail") return json(req, res, 200, readChain(trailDir(work)).map(entryRow).reverse());
      if (p === "/trail/verify") {
        const check = verifyChain(trailDir(work));
        return json(req, res, 200, { ok: check.ok, count: check.entries, ...(check.broken.length ? { brokenAt: check.broken[0].name, why: check.broken[0].why, broken: check.broken } : {}) });
      }
      const entry = p.match(/^\/trail\/([\w.-]+\.md)$/);
      if (entry) {
        const e = readChain(trailDir(work)).find((x) => x.name === entry[1]);
        return e ? json(req, res, 200, { ...entryRow(e), markdown: e.body }) : json(req, res, 404, { error: `no trail entry ${entry[1]}` });
      }
      if (p === "/link") return json(req, res, 200, linkNow());
      if (p === "/heph" || p.startsWith("/heph/")) {
        if (!hephStore) return json(req, res, 404, { error: "this runtime does not read Hephaestus's record" });
        const q = url.searchParams;
        if (p === "/heph/quests") return json(req, res, 200, await hephStore.list({ days: q.get("days"), limit: q.get("limit") }));
        const one = p.match(/^\/heph\/quests\/((?:quest:)?\d{1,20})$/);
        if (one) {
          const found = await hephStore.get(one[1], { days: q.get("days") });
          return found ? json(req, res, 200, found) : json(req, res, 404, { error: `no Hephaestus quest ${one[1]} in the record` });
        }
        return json(req, res, 404, { error: `no route ${req.method} ${p}` });
      }
      if (p === "/setup") return setups ? json(req, res, 200, setups.read()) : json(req, res, 404, noSetup);
      if (isChats(p)) {
        const r = chats.route("GET", p);
        return json(req, res, r.status, r.body);
      }
      const quest = p.match(/^\/quests\/([\w-]+)$/);
      if (quest) {
        const q = queue.get(quest[1]) ?? past.get(quest[1]);
        return q ? json(req, res, 200, q) : json(req, res, 404, { error: `no quest ${quest[1]}` });
      }
      return json(req, res, 404, { error: `no route ${req.method} ${p}` });
    }

    // PATCH and DELETE exist for the conversations only; every method from here on changes something
    const chatWrite = (req.method === "PATCH" || req.method === "DELETE") && isChats(p);
    if (req.method !== "POST" && !chatWrite) return json(req, res, 404, { error: `no route ${req.method} ${p}` });
    if (!trustedOrigin(req)) return json(req, res, 403, { error: "only this computer may talk to Chronos" });

    let b;
    try {
      b = await readBody(req);
    } catch (err) {
      return json(req, res, err.status ?? 400, { error: err.message });
    }

    if (isChats(p)) {
      const r = chats.route(req.method, p, b);
      return json(req, res, r.status, r.body);
    }

    if (p === "/shutdown") {
      if (!onShutdown) return json(req, res, 409, { error: "this server was not started in a way that lets it be shut down over HTTP" });
      // answer first, then go: the caller reads its 202 before the port closes
      res.once("finish", () => setImmediate(() => Promise.resolve().then(() => onShutdown("POST /shutdown")).catch((err) => bus.emit("log", { level: "error", text: `shutdown failed: ${err?.message ?? err}` }))));
      return json(req, res, 202, { ok: true, stopping: true });
    }

    if (p === "/setup/download" || p === "/setup/cancel") {
      if (!setups) return json(req, res, 404, noSetup);
      const r = p === "/setup/download" ? setups.download(b) : setups.cancel(b);
      return json(req, res, r.status, r.body);
    }

    // the brains: a thrown Error is a refusal with its reason
    const refusing = async (fn) => {
      try {
        return json(req, res, 200, (await fn()) ?? { ok: true });
      } catch (err) {
        return json(req, res, 409, { error: err?.message ?? String(err) });
      }
    };

    const brainAction = p.match(/^\/brains\/([\w.-]+)\/(start|stop)$/);
    if (brainAction) return refusing(() => brains[brainAction[2]](brainAction[1]));
    if (p === "/brains/switch") {
      if (!b.slot || !b.id) return json(req, res, 400, { error: "a switch needs a slot and a brain id" });
      return refusing(() => brains.switchSlot(String(b.slot), String(b.id)));
    }

    if (p === "/chat") {
      if (!Array.isArray(b.messages) || !b.messages.length) return json(req, res, 400, { error: "a chat needs messages" });
      const brain = pickBrain(b);
      if (!brain) return json(req, res, 404, { error: b.brain ? `no brain ${b.brain}` : `no brain in slot ${b.slot || "talk"}` });
      return refusing(async () => {
        if (brain.status !== "ready") await brains.start(brain.id);
        const opts = {};
        if (b.thinking !== undefined) opts.thinking = !!b.thinking;
        if (b.maxTokens !== undefined) opts.maxTokens = Number(b.maxTokens);
        const out = await brains.chat(brain.id, b.messages, opts);
        return { brain: brain.id, ...out };
      });
    }

    if (p === "/quests") {
      const task = String(b.task ?? "").trim();
      // a task that is only a size marker is no task
      if (!parseSizeMarker(task).task) return json(req, res, 400, { error: "a quest needs a task" });
      if (b.size != null && !normalSize(b.size)) return json(req, res, 400, { error: `no size ${JSON.stringify(b.size)}: a quest is auto, s, m or l` });
      if (b.brain != null && !regularBrains().some((x) => x.id === b.brain)) return json(req, res, 400, { error: `no brain ${JSON.stringify(b.brain)} to take the Titan's seat` });
      let budget = null;
      if (b.budget != null) {
        const ok = typeof b.budget === "object" && !Array.isArray(b.budget) && ["tokens", "seconds"].every((k) => b.budget[k] == null || (typeof b.budget[k] === "number" && Number.isFinite(b.budget[k]) && b.budget[k] > 0));
        if (!ok) return json(req, res, 400, { error: "a budget is {tokens?, seconds?}, each a number above 0" });
        budget = { ...(b.budget.tokens != null ? { tokens: b.budget.tokens } : {}), ...(b.budget.seconds != null ? { seconds: b.budget.seconds } : {}) };
        if (!Object.keys(budget).length) budget = null;
      }
      const bad = badAttachments(b.attachments) ?? missingAttachment(b.attachments);
      if (bad) return json(req, res, 400, { error: bad });
      // a caller that retries with the same idempotency key gets the quest it already made
      const idem = String(req.headers["idempotency-key"] ?? b.idempotencyKey ?? "").trim();
      const seen = idem ? bridge.idempotency.get(`quest:${idem}`) : null;
      const before = seen ? (queue.get(seen.quest) ?? past.get(seen.quest)) : null;
      if (before) return json(req, res, 202, { id: before.id, status: before.status, size: before.size, tier: before.tier, duplicate: true });
      const q = queue.add({ task, by: b.by ?? null, size: b.size ?? null, brain: b.brain ?? null, budget, attachments: b.attachments ?? null });
      if (idem) bridge.idempotency.set(`quest:${idem}`, q.id);
      return json(req, res, 202, { id: q.id, status: q.status, size: q.size, tier: q.tier, ...(q.attachments ? { attachments: q.attachments } : {}) });
    }

    const stopQuest = p.match(/^\/quests\/([\w-]+)\/stop$/);
    if (stopQuest) {
      const q = queue.get(stopQuest[1]);
      if (!q) return json(req, res, 404, { error: `no quest ${stopQuest[1]}` });
      if (q.status === "queued") {
        q.status = "stopped";
        q.stop = true;
        bus.emit("quest.done", { id: q.id, status: "stopped", size: q.size, tier: q.tier, summary: "stopped before it started", ...(q.chat ? { chat: q.chat } : {}) });
        return json(req, res, 200, { id: q.id, status: q.status });
      }
      if (q.status !== "running") return json(req, res, 200, { id: q.id, status: q.status });
      if (!runner?.stop) return json(req, res, 409, { error: "no runner to stop" });
      q.stop = true;
      runner.stop(q.id);
      return json(req, res, 200, { id: q.id, status: q.status, stopping: true });
    }

    if (p === "/bridge/arrive") {
      // a path among the attachments names a file on this computer: taken only from a program here, never a web page
      const r = await bridge.arrive(b, { local: isLoopback(req.socket?.remoteAddress) && !req.headers.origin });
      // the answer goes home when this quest reaches quest.done (runtime/bridge.mjs)
      return json(req, res, r.status, r.body);
    }

    if (p === "/bridge/answer") {
      const r = bridge.answer(b);
      return json(req, res, r.status, r.body);
    }

    if (p === "/envoys") {
      try {
        const sent = await bridge.dispatch({ to: b.to, ask: b.ask, by: b.by ?? null, attachments: Array.isArray(b.attachments) ? b.attachments : null });
        return json(req, res, 202, { id: sent.id, to: sent.to });
      } catch (err) {
        return json(req, res, err.status ?? 400, { error: err?.message ?? String(err) });
      }
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
        // the outbox: answers home left from before a restart are sent again (runtime/bridge.mjs)
        bridge.start();
        resolve(server.address().port);
      });
    });
  }

  async function close() {
    await runner?.close?.();
    await setups?.close?.();
    await chats.close();
    bridge.close();
    if (mediaTmp) fs.rmSync(mediaTmp, { recursive: true, force: true });
    bus.off?.("hardware.read", onHeat);
    bus.off?.("quest.done", keep);
    bus.closeAll();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(() => r()));
  }

  return { server, bus, queue, bridge, chats, ledger, history: past, brains, hardware, runner, setup: setups, media: store, capabilities: caps, listen, close, url: () => `http://${host}:${listening()?.port ?? port}` };
}

/** Stop the runtime in the order that preserves partial chats: close app streams, then stop brains. */
export async function shutdownRuntime({ app, brains, stopHardware = () => {}, beacon = null, ledger = null, sig = "shutdown", exit = (code) => process.exit(code), log = console.log } = {}) {
  log?.(`chronos stopping (${sig})`);
  app?.bus?.emit?.("log", { down: true, why: sig, text: `chronos stopping (${sig})` });
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
    ledger?.close?.();
  }
  exit?.(0);
}

/** Start everything: the bus, the senses, the brains, the beacon, the server. */
export async function main() {
  const host = process.env.CHRONOS_HOST || "127.0.0.1";
  const port = Number(process.env.CHRONOS_PORT) || 7777;
  const home = defaultHome();
  // the ledger numbers every event and keeps it by day, so what went on outlives a restart
  let ledger = null;
  try {
    ledger = createLedger({ home });
    ledger.tidy();
  } catch (err) {
    console.error(`chronos: no ledger under ${home} (${err?.message ?? err}); events are kept in memory only`);
  }
  const bus = new Bus({ ledger });
  const { hardware, brains, missing } = await loadModules({ root: ROOT, home, bus, port });
  // the work folder, apart from the code (CHRONOS_WORKDIR): made on first use; without it everything stays in the code folder
  const workdir = process.env.CHRONOS_WORKDIR ? path.resolve(process.env.CHRONOS_WORKDIR) : null;
  if (workdir) fs.mkdirSync(workdir, { recursive: true });
  let shutdown = async () => {};
  // the runner's root is where its trail is written and where its tools read and write: the work folder when there is one
  const runner = createRunner({ root: workdir ?? ROOT, brains, hardware, bus });
  const app = createServer({ root: ROOT, home, port, host, bus, brains, hardware, missing, runner, workdir, onShutdown: (why) => shutdown(why) });
  const stopHardware = hardware.watchHardware(bus, HARDWARE_MS);
  await app.listen();
  // the beacon carries the hash of GET /capabilities, so Hephaestus fetches the manifest again only when it changed
  const beacon = startBeacon({ port, root: ROOT, id: "chronos", name: "Chronos", host, extra: () => ({ capabilities: app.capabilities.hash(), capabilitiesUrl: "/capabilities" }) });
  console.log(`chronos listening on ${app.url()}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
  bus.emit("log", { up: true, pid: process.pid, port, commit: readCommit(ROOT), text: `chronos up on ${app.url()}` });

  let stopping = false;
  shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    await shutdownRuntime({ app, brains, stopHardware, beacon, ledger, sig });
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
