// The UI's one store: the event stream (GET /events: the ring replayed, then live; after a drop it
// comes back with ?since=<the last n>, ui/api.js), what the events add up to (the hardware, the
// brains, the quests with their agents, phases and lines, this session's log) and the calls that
// change it. Views read `state` and listen with on(); a name that starts with "@" is a change in
// the store ("@quests" with the quest's id), anything else is a runtime event by its type ("*"
// hears them all). Carried from Chronos's ui/store.js and cut to what Lite serves: no chats, no
// setup, no envoys, no /brains (the brains ride on /health).
//
// window.lite.inject(event) pushes a fake event down the same path:
//   lite.inject({ type: "agent.spawned", id: "cp-1", tier: "promethean", quest: "q-1", brain: "qwen3.5-4b", task: "count" })

import { api, followEvents } from "./api.js";

export const BOOT = Date.now();

// ---- listeners ---------------------------------------------------------------

const listeners = new Map(); // name -> Set<fn>

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

function hear(name, payload) {
  for (const fn of listeners.get(name) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`a listener for ${name} threw`, err);
    }
  }
}

/** Say that a part of the store changed. */
export const notify = (topic, payload) => hear(`@${topic}`, payload);

// ---- the state ---------------------------------------------------------------

export const state = {
  health: null,
  healthError: null,
  /** the brains as /health names them, their status kept current by the brain.* events */
  brains: [],
  hardware: null,
  /** id -> { id, task, by, status, at, size, tier, phase, phaseBrain, agents: Map, lines: [], summary, report? } */
  quests: new Map(),
  questsError: null,
  counts: null,
  /** this session's events, oldest first (no hardware.read) */
  log: [],
  /** the event of a throttle.hold or heat.cutoff that still stands, else null */
  hold: null,
  /** brain id -> the brain.waiting event while a brain waits for the card another service holds */
  waiting: new Map(),
  /** brain id -> the time its loading began */
  loading: new Map(),
  /** the newest event that is not a hardware reading */
  last: null,
  stream: { up: false, since: null, state: "connecting" },
};
const LOG_MAX = 800;

// ---- events ------------------------------------------------------------------

const seenN = new Set();

export function dispatch(ev) {
  if (!ev || typeof ev !== "object" || !ev.type) return false;
  if (typeof ev.t !== "number") ev = { t: Date.now(), ...ev };
  if (typeof ev.n === "number") {
    if (seenN.has(ev.n)) return false;
    seenN.add(ev.n);
    if (seenN.size > 4000) seenN.delete(seenN.values().next().value);
  }
  // what the stream replays from before this page opened is history: it fills the store, it is not news
  if (ev.replayed === undefined) ev.replayed = ev.t < BOOT - 1500;
  reduce(ev);
  hear(ev.type, ev);
  hear("*", ev);
  return true;
}

/** A fake event from the console, down the same path as the stream. */
export function inject(ev) {
  if (typeof ev === "string") ev = { type: ev };
  return dispatch({ t: Date.now(), ...ev });
}

// ---- the stream --------------------------------------------------------------

let stream = null;

export function connect() {
  stream?.close();
  stream = followEvents({
    onEvent: dispatch,
    onState(s) {
      const back = s === "live" && state.stream.state === "reconnecting";
      state.stream.state = s;
      state.stream.up = s === "live";
      if (s === "live") state.stream.since = Date.now();
      notify("stream");
      // after a drop, what happened meanwhile is read again from the routes
      if (back) refreshAll();
    },
  });
  return stream;
}
export const retryStream = () => stream?.retryNow();

// ---- reducing events into the state ------------------------------------------

function questOf(id, seedFrom) {
  let q = state.quests.get(id);
  if (!q) {
    q = { id, task: "", by: null, status: "queued", at: seedFrom?.t ?? Date.now(), size: null, tier: null, phase: null, phaseBrain: null, agents: new Map(), lines: [], summary: null };
    state.quests.set(id, q);
  }
  q.agents ??= new Map();
  q.lines ??= [];
  return q;
}

const BRAIN_STATUS = { "brain.loading": "loading", "brain.ready": "ready", "brain.failed": "failed", "brain.stopped": "idle", "brain.waiting": "waiting" };

function reduce(ev) {
  const t = ev.type;
  if (t === "hardware.read") {
    state.hardware = ev;
    notify("hardware", ev);
    return;
  }
  state.log.push(ev);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  if (!state.last || ev.t >= state.last.t) state.last = ev;

  if (t.startsWith("brain.")) {
    if (t === "brain.loading") state.loading.set(ev.id, ev.t);
    else if (ev.id) state.loading.delete(ev.id);
    if (t === "brain.waiting") state.waiting.set(ev.id, ev);
    else if (ev.id) state.waiting.delete(ev.id);
    const b = state.brains.find((x) => x.id === ev.id);
    if (b && BRAIN_STATUS[t]) b.status = BRAIN_STATUS[t];
    notify("brains");
  } else if (t === "throttle.hold" || t === "heat.cutoff") {
    state.hold = ev;
    notify("hold", ev);
  } else if (t === "throttle.release" || t === "heat.clear") {
    // a release ends a hold, a clear ends a cutoff (a cutoff outlives a release)
    if (state.hold && (t === "heat.clear" || state.hold.type === "throttle.hold")) state.hold = null;
    notify("hold", null);
  } else if (t === "quest.queued" || t === "quest.started") {
    const q = questOf(ev.id, ev);
    q.task = ev.task ?? q.task;
    q.by = ev.by ?? q.by;
    q.at = Math.min(q.at ?? ev.t, ev.t);
    if (ev.size) q.size = String(ev.size).toLowerCase();
    if (ev.tier) q.tier = ev.tier;
    if (ev.downgraded) q.downgraded = ev.downgraded;
    notify("quests", ev.id);
  } else if (t === "quest.running") {
    const q = questOf(ev.id, ev);
    if (q.status === "queued") q.status = q.stopAsked ? "stopping" : "running";
    q.startedAt ??= ev.t;
    if (ev.size) q.size = String(ev.size).toLowerCase();
    if (ev.tier) q.tier = ev.tier;
    if (ev.downgraded) q.downgraded = ev.downgraded;
    notify("quests", ev.id);
  } else if (t === "quest.phase") {
    const q = questOf(ev.id, ev);
    q.phase = ev.phase;
    q.phaseBrain = ev.brain ?? null;
    if (q.status === "queued") q.status = "running";
    notify("quests", ev.id);
  } else if (t === "quest.done") {
    const q = questOf(ev.id, ev);
    q.status = ev.status ?? "done";
    q.summary = ev.summary ?? q.summary;
    q.why = ev.why ?? q.why ?? null;
    q.finishedAt = ev.t;
    if (ev.size) q.size = String(ev.size).toLowerCase();
    if (ev.tier) q.tier = ev.tier;
    if (ev.report) q.report = ev.report;
    for (const a of q.agents.values()) if (a.status === "running") a.status = q.status === "stopped" ? "stopped" : "done";
    notify("quests", ev.id);
  } else if (t === "agent.spawned") {
    if (ev.quest) {
      const q = questOf(ev.quest, ev);
      if (q.status === "queued") q.status = "running";
      q.agents.set(ev.id, { id: ev.id, tier: ev.tier, parent: ev.parent ?? null, brain: ev.brain, task: ev.task, depth: ev.depth ?? 0, status: "running", at: ev.t, last: null });
      notify("quests", ev.quest);
    }
  } else if (t === "agent.done" || t === "agent.split") {
    const q = ev.quest ? state.quests.get(ev.quest) : null;
    const a = q?.agents?.get(ev.id);
    if (a) {
      if (t === "agent.done") Object.assign(a, { status: a.split && ev.status === "fell" ? a.status : (ev.status ?? "done"), summary: ev.summary, doneAt: ev.t });
      else Object.assign(a, { split: ev.children?.length ?? 2, status: "fell" });
      notify("quests", ev.quest);
    }
  } else if (t === "log") {
    const q = ev.quest ? state.quests.get(ev.quest) : null;
    if (q) {
      q.lines.push({ t: ev.t, id: ev.id ?? null, text: ev.text ?? "", judge: ev.judge ?? null, score: ev.score ?? null });
      if (q.lines.length > 200) q.lines.splice(0, q.lines.length - 200);
      const a = ev.id ? q.agents.get(ev.id) : null;
      if (a && !ev.judge) a.last = ev.text;
      notify("quests", ev.quest);
    }
  }
  notify("log", ev);
}

// ---- reading the routes ------------------------------------------------------

const why = (err) => err?.message ?? String(err);

export async function refreshHealth() {
  try {
    const body = await api.health();
    state.health = body;
    state.healthError = null;
    // /health is polled every few seconds; between two reads the brain.* events keep each status current
    state.brains = (body.brains ?? []).map((b) => ({ ...b, status: state.waiting.has(b.id) ? "waiting" : b.status }));
    if (body.hardware && !state.hardware) state.hardware = body.hardware;
    state.counts = body.quests ?? state.counts;
  } catch (err) {
    state.healthError = why(err);
  }
  notify("health");
  notify("brains");
  return state.health;
}

function mergeQuest(row) {
  const q = questOf(row.id, { t: row.at });
  const live = { agents: q.agents, lines: q.lines, phase: q.phase, phaseBrain: q.phaseBrain, report: q.report, stopAsked: q.stopAsked };
  // the list may be a moment older than the stream: a finished quest never moves back
  const stale = (q.status !== "queued" && q.status !== "running" && q.status !== "stopping" && (row.status === "queued" || row.status === "running")) || (q.status === "stopping" && row.status === "running");
  const status = stale ? q.status : row.status;
  Object.assign(q, row, live, { status: status ?? q.status });
  if (row.report) q.report = row.report;
  if (row.size) q.size = String(row.size).toLowerCase();
  return q;
}

export const quests = {
  async refresh() {
    try {
      const { quests: rows, counts } = await api.list();
      for (const row of rows) mergeQuest(row);
      state.counts = counts ?? state.counts;
      state.questsError = null;
    } catch (err) {
      state.questsError = why(err);
    }
    notify("quests");
  },
  /** One quest in full (the report rides only on this read). */
  async load(id) {
    try {
      const body = await api.quest(id);
      if (body?.id) mergeQuest(body);
      notify("quests", id);
      return { ok: true, status: 200, body };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, why: why(err) };
    }
  },
  async send(task, size) {
    try {
      const body = await api.send(task, size);
      if (body?.id && !state.quests.has(body.id)) dispatch({ type: "quest.queued", id: body.id, task, size: body.size, by: "ui", t: Date.now() });
      return { ok: true, body };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, why: why(err) };
    }
  },
  async stop(id) {
    const q = state.quests.get(id);
    if (q) {
      q.stopAsked = true;
      if (q.status === "running" || q.status === "queued") q.status = "stopping";
      notify("quests", id);
    }
    try {
      return { ok: true, body: await api.stop(id) };
    } catch (err) {
      return { ok: false, status: err.status ?? 0, why: why(err) };
    }
  },
  /** newest first */
  list: () => [...state.quests.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
  /** the quest that runs now, else the first that waits */
  running() {
    const all = [...state.quests.values()];
    return all.find((q) => q.status === "running" || q.status === "stopping") ?? all.filter((q) => q.status === "queued").sort((a, b) => a.at - b.at)[0] ?? null;
  },
};

export async function refreshAll() {
  await Promise.all([refreshHealth(), quests.refresh()]);
}
