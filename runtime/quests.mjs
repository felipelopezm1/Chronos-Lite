// The quest runner: Chronos over the Prometheans. Chronos Lite carries it
// with two sizes (s, m), a fall split at most MAX_DEPTH (2) deep, and at most
// QUEST_TURNS (25) brain calls a quest, all held in lite/edition.json. For one quest {id, task, by}
// the titan brain (slot "talk") plans 1 to 3 tasks, each with a finish line
// and a rubric; Prometheans (slot "promethean") run them concurrently up to a
// cap the hardware sense gives; one that falls is split into two Offspring
// (slot "offspring") that start from its partial work, down to a depth cap
// after which it is blocked; a different brain than the author judges every
// finished report against its rubric; the whole is gathered into a report,
// written as one chained trail entry, and every step goes on the bus.
//
// Events, in Hephaestus's shape: agent.spawned {id, kind:"wisp", arm:"chronos",
// vendor:"chronos", tier, parent, brain, quest}, agent.split {id, children},
// agent.done {id, status}, quest.done {id, status, report}, log.
//
// The queue loop (start(queue)) takes quests one at a time; stop(id) raises a
// flag the workers honour between turns.
//
// Sizes (runtime/sizes.mjs): when the runner takes a quest it resolves its
// tier, the brains that do the work, from the quest's size (s, m, or auto by
// the task's words; an l runs as m) and forge/brains.json `tiers`,
// and says quest.running {id, size, tier}. With no tiers configured every
// quest is m on the brains in the slots, which is the behaviour before sizes.
//
//   s   no Titan: no plan, the whole quest is one task for one Promethean
//       (two Offspring if it falls); the Offspring's brain judges it.
//   m   the Titan plans up to 3 tasks, splits the falls and judges.
//
// A Titan marked exclusive (alone on the GPU) would run the quest in three
// phases with two swaps; Lite's catalogue has none, so that path is full
// Chronos's l path, kept only so this file stays close to its source.
//
// quest.phase {id, phase: "plan"|"work"|"judge", brain} marks each phase. A
// tier whose lead brain is not on disk, or whose Titan will not load, falls
// back to the next smaller tier and says so in a log event. The tier's caps
// (tokens the brains generate, seconds of running time, and Lite's 25 brain
// turns; a quest's own `budget {tokens?, seconds?}` overrides the first two)
// stop a quest that passes them,
// with the reason; waits for a cool card are not counted in the seconds.

import { createTools } from "./tools.mjs";
import { agentId, partialState, runPromethean, splitTask } from "./promethean.mjs";
import { resolveTier } from "./sizes.mjs";
import { trailDir, writeTrail } from "./trail.mjs";

/** what one Promethean takes on the GPU (the 4B worker's footprint) */
export const WORKER_MiB = 3300;

/** how deep a fall may split: 0 -> 1 -> 2, then blocked (lite/edition.json quest.splitDepth) */
export const MAX_DEPTH = 2;

/** the most brain calls one quest makes, plan, work and judging together (lite/edition.json quest.maxTurns) */
export const QUEST_TURNS = 25;

/** which brain slot plays which part */
export const DEFAULT_SLOTS = { titan: "talk", promethean: "promethean", offspring: "offspring" };

/** a judge's score under this makes a done report count as partial */
export const PASS_SCORE = 0.5;

export const PERSONA = `You are Chronos, the Titan of the forge: one mind over three brains, rough and direct. You run on one Linux box with your own local agents, the Prometheans, and you plan, cap, judge and record their work. You say what was checked and what was guessed, in few words.`;

export const DEFAULT_RUBRIC = [
  "The task is done as asked, nothing beyond it.",
  "What was checked with a tool is listed as verified; guesses as inferred.",
  "Every file touched is named.",
  "Open questions and mistakes caught are reported honestly.",
];

/** the most tasks a plan has when the tier does not say */
export const MAX_TASKS = 3;

const planSchema = (max = MAX_TASKS) => ({
  name: "plan",
  schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: max,
        items: {
          type: "object",
          properties: { task: { type: "string" }, finish: { type: "string" }, rubric: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 } },
          required: ["task", "finish", "rubric"],
        },
      },
    },
    required: ["tasks"],
  },
});

const JUDGE_SCHEMA = {
  name: "judgement",
  schema: {
    type: "object",
    properties: { score: { type: "number", minimum: 0, maximum: 1 }, verdict: { type: "string" }, note: { type: "string" } },
    required: ["score", "verdict", "note"],
  },
};

const BATCH_SCHEMA = {
  name: "judgements",
  schema: {
    type: "object",
    properties: {
      judgements: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, score: { type: "number", minimum: 0, maximum: 1 }, verdict: { type: "string" }, note: { type: "string" } },
          required: ["id", "score", "verdict", "note"],
        },
      },
    },
    required: ["judgements"],
  },
};

/** the most reports one batch call judges; more are judged in several calls on the same loaded brain */
export const BATCH_MAX = 10;

/** pacing: no GPU call starts at or above this junction temperature (CHRONOS_PACE_C) */
export const PACE_C = 88; // above the governor's 84 C target, so it waits only when the governor is losing

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });

/**
 * How many Prometheans may run now: floor(free VRAM for workers / footprint),
 * at least 1, at most the worker brain's parallel slots, and 0 while the GPU
 * junction is hot. No reading at all is taken as room for one.
 */
export function workerCap(hw, { footprintMiB = WORKER_MiB, parallel = 1, reserveVramMiB = 512 } = {}) {
  if (!hw) return 1;
  if (hw.heat?.hot) return 0;
  const room = Math.max(0, (hw.vram?.freeMiB ?? 0) - reserveVramMiB);
  return Math.max(1, Math.min(Math.max(1, parallel), Math.floor(room / footprintMiB)));
}

/** The JSON object in a reply: a fenced block, else the outermost braces. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {
      /* the next */
    }
  }
  return null;
}

const strings = (v, max) =>
  (Array.isArray(v) ? v : [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, max);

/**
 * The plan out of the titan's reply: 1 to `max` (3) tasks with a finish line
 * and a 3-to-5-line rubric each. Null when it does not parse.
 */
export function parsePlan(text, max = MAX_TASKS) {
  const v = extractJson(text);
  const raw = Array.isArray(v?.tasks) ? v.tasks : Array.isArray(v) ? v : null;
  if (!raw) return null;
  const tasks = raw
    .filter((t) => t && typeof t.task === "string" && t.task.trim())
    .slice(0, Math.max(1, Number(max) || MAX_TASKS))
    .map((t) => {
      let rubric = strings(t.rubric, 5);
      if (rubric.length < 3) rubric = [...rubric, ...DEFAULT_RUBRIC].slice(0, Math.max(3, rubric.length));
      return { task: t.task.trim(), finish: String(t.finish ?? "").trim() || "the task is done and reported", rubric };
    });
  return tasks.length ? tasks : null;
}

/** One task that is the whole quest, when the plan does not parse. */
export function fallbackPlan(task) {
  return [{ task, finish: "the task is done and reported", rubric: [...DEFAULT_RUBRIC] }];
}

/** {score 0..1, verdict, note} out of a judge's reply; null when it does not parse. */
export function parseJudgement(text) {
  const v = extractJson(text);
  if (!v) return null;
  const n = Number(v.score);
  if (!Number.isFinite(n)) return null;
  return { score: Math.min(1, Math.max(0, n)), verdict: String(v.verdict ?? "").trim() || (n >= PASS_SCORE ? "pass" : "fail"), note: String(v.note ?? "").trim() };
}

/**
 * The judgements out of a batch reply: Map of id (or the report's number) ->
 * {score, verdict, note}. Empty when it does not parse.
 */
export function parseJudgements(text) {
  const out = new Map();
  const v = extractJson(text);
  const raw = Array.isArray(v?.judgements) ? v.judgements : Array.isArray(v) ? v : v && (v.id != null || v.n != null) ? [v] : [];
  for (const j of raw) {
    const key = j?.id ?? j?.n;
    const n = Number(j?.score);
    if (key == null || !Number.isFinite(n)) continue;
    out.set(String(key).trim(), { score: Math.min(1, Math.max(0, n)), verdict: String(j.verdict ?? "").trim() || (n >= PASS_SCORE ? "pass" : "fail"), note: String(j.note ?? "").trim() });
  }
  return out;
}

/** The tokens a reply generated: the server's own count, else a rough one from its text. */
export function generatedTokens(reply) {
  const n = reply?.usage?.completion_tokens;
  if (Number.isFinite(n) && n >= 0) return n;
  const calls = reply?.toolCalls?.length ? JSON.stringify(reply.toolCalls).length : 0;
  return Math.ceil(((typeof reply?.content === "string" ? reply.content.length : 0) + calls) / 4);
}

/** A quest's caps: the tier's, with the quest's own `budget {tokens?, seconds?}` over them. */
export function questCaps(tierCaps = {}, budget = null) {
  const caps = { ...tierCaps };
  for (const k of ["tokens", "seconds"]) {
    const v = Number(budget?.[k]);
    if (budget?.[k] != null && Number.isFinite(v) && v > 0) caps[k] = v;
  }
  return caps;
}

const clip = (t, n) => (String(t ?? "").length > n ? `${String(t).slice(0, n)}...` : String(t ?? ""));
const few = (list, n = 6, each = 160) => (Array.isArray(list) ? list.slice(0, n).map((x) => clip(x, each)) : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Run fn over items with at most `limit` in flight; results in item order. */
/** the file paths a task names (word/word.ext or name.ext); used to keep two workers off one file */
export function filesNamed(text) {
  return new Set((String(text).match(/[\w./-]*\w\.(?:md|txt|json|jsonl|mjs|js|ts|tsx|css|html|py|sh|yml|yaml|toml|csv)\b/gi) ?? []).map((f) => f.replace(/^\.\//, "")));
}

/** the first file two or more planned tasks share, or null */
export function sharesAFile(tasks) {
  const seen = new Set();
  for (const t of tasks) {
    for (const f of filesNamed(t.task)) {
      if (seen.has(f)) return f;
    }
    for (const f of filesNamed(t.task)) seen.add(f);
  }
  return null;
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** The status of the quest out of its leaf reports and their judgements. */
export function questStatus(reports, judged, { stopped = false } = {}) {
  if (stopped) return "stopped";
  const leaves = reports.filter((r) => r.status !== "fell");
  if (!leaves.length) return "blocked";
  const scoreOf = new Map(judged.filter((j) => !j.advisory).map((j) => [j.id, j.score]));
  const passed = leaves.filter((r) => r.status === "done" && (scoreOf.get(r.id) ?? 1) >= PASS_SCORE);
  if (passed.length === leaves.length) return "done";
  if (leaves.some((r) => r.status === "done" || r.status === "partial")) return "partial";
  return "blocked";
}

export function advisorySummary(judged) {
  const advisory = judged.filter((j) => j.advisory);
  if (!advisory.length) return "";
  const lines = advisory.map((j) => `${j.id} by ${j.by ?? "nobody"}: ${j.score} ${j.verdict}${j.note ? ` - ${j.note}` : ""}`);
  return ` Advisory ${advisory.length === 1 ? "judgement was" : "judgements were"} advisory and could not change the quest status: ${lines.join("; ")}.`;
}

/**
 * The runner. `brains` is a Brains (or a stand-in with list, start and chat;
 * stop is used when it is there), `hardware` the sense module (readHardware),
 * `bus` the Bus. `tiers` is forge/brains.json `tiers` (the Brains' own
 * catalogue when left out; null: no sizes, every quest is m on the slots).
 */
/** What a quest asks, with what was attached to it (server.mjs createQueue keeps their text as `attached`). */
export function questAsk(quest) {
  const attached = typeof quest?.attached === "string" ? quest.attached.trim() : "";
  return attached ? `${quest.task}\n\nAttached:\n${attached}` : String(quest?.task ?? "");
}

export function createRunner({
  root,
  brains,
  hardware = null,
  bus = { emit() {}, on() {} },
  slots = DEFAULT_SLOTS,
  tiers,
  trail = null,
  tools = null,
  persona = PERSONA,
  maxDepth = MAX_DEPTH,
  maxTurns = QUEST_TURNS,
  budget = {},
  footprintMiB = WORKER_MiB,
  coolPollMs = 5000,
  coolMaxMs = 10 * 60 * 1000,
  paceC = Number(process.env.CHRONOS_PACE_C) || PACE_C,
  maxTokens = 1024,
  settleMs = 500,
  now = () => new Date(),
} = {}) {
  if (!root) throw new Error("the runner needs a project root");
  if (!brains?.chat || !brains?.list) throw new Error("the runner needs brains with list and chat");
  const dir = trail ?? trailDir(root);
  const tierTable = tiers !== undefined ? tiers : (brains.catalogue?.tiers ?? brains.tiers ?? null);
  const active = new Map();
  let queue = null;
  let closed = false;
  let loop = null;
  let wake = null;
  /** an exclusive brain the last quest left up because the next one plans on it */
  let keptFor = null;

  const log = (quest, text, extra = {}) => bus.emit("log", { quest, text, ...extra });

  /** The tier a quest runs on now (runtime/sizes.mjs): from what it asked, else its stamped size, else auto. */
  const resolveFor = (quest, extra = {}) => resolveTier({ asked: quest.asked ?? quest.size ?? "auto", task: quest.task, tiers: tierTable, list: brains.list(), slots, brain: quest.brain ?? null, ...extra });

  function parallelOf(b) {
    if (Number.isInteger(b?.parallel)) return b.parallel;
    try {
      const p = brains.brainOf?.(b.id)?.parallel;
      return Number.isInteger(p) ? p : 1;
    } catch {
      return 1;
    }
  }

  const entryOf = (id) => brains.list().find((x) => x.id === id) ?? null;
  const onGpu = (id) => (entryOf(id)?.device ?? "gpu") !== "cpu";
  const isUp = (id) => ["ready", "loading"].includes(entryOf(id)?.status);

  // ---- the meter of one quest: the tokens its brains generated, its running time, its caps ----

  const newMeter = (ac) => ({ tokens: 0, turns: 0, startMs: Date.now(), waitedMs: 0, waiting: 0, waitingSince: 0, caps: {}, over: null, ac });

  /** a wait for a cool card begins or ends; the time between is not running time */
  function waitBegins(m) {
    if (m && m.waiting++ === 0) m.waitingSince = Date.now();
  }
  function waitEnds(m) {
    if (m && --m.waiting === 0) m.waitedMs += Date.now() - m.waitingSince;
  }
  const ranMs = (m) => Date.now() - m.startMs - m.waitedMs - (m.waiting > 0 ? Date.now() - m.waitingSince : 0);

  /** The reason a quest is over a cap, or null; the first time, it raises the quest's stop flag and says so. */
  function overCap(m, quest) {
    if (!m) return null;
    if (m.over) return m.over;
    const { tokens, seconds, turns } = m.caps;
    const ran = ranMs(m) / 1000;
    if (turns && m.turns > turns) m.over = `the quest passed its cap of ${turns} brain turns`;
    else if (tokens && m.tokens > tokens) m.over = `the quest passed its cap of ${tokens} tokens (${m.tokens} generated)`;
    else if (seconds && ran > seconds) m.over = `the quest passed its cap of ${seconds} s of running time (${Math.round(ran * 10) / 10} s, waits for a cool card not counted)`;
    if (!m.over) return null;
    m.ac?.abort();
    log(quest, `${m.over}: the workers finish their turn and halt`, { cap: true });
    return m.over;
  }

  /**
   * Pacing: no GPU call starts while the junction is at or above paceC. This
   * laptop's fans are already at full speed when it climbs, so the only lever
   * is to let it cool between calls. Waits at most coolMaxMs; with a quest's
   * meter the wait is not counted as its running time.
   */
  async function coolEnough(signal, who, m = null) {
    const start = Date.now();
    let said = false;
    try {
      for (;;) {
        const j = hardware?.readHardware?.()?.heat?.junctionC;
        if (!Number.isFinite(j) || j < paceC || signal?.aborted || Date.now() - start >= coolMaxMs) return;
        if (!said) {
          bus.emit("log", { text: `pacing: the GPU junction is at ${j} C; ${who ?? "the next call"} waits for it to fall under ${paceC} C`, pace: true, junctionC: j });
          said = true;
          waitBegins(m);
        }
        await sleep(coolPollMs, signal);
      }
    } finally {
      if (said) waitEnds(m);
    }
  }

  /** Stop one brain that is up, and give the driver a moment to hand its memory back. True when it was stopped. */
  async function stopBrain(id, quest, why) {
    if (typeof brains.stop !== "function" || !isUp(id)) return false;
    log(quest, why, { brain: id, stopping: true });
    try {
      await brains.stop(id);
    } catch (err) {
      log(quest, `${id} would not stop: ${err?.message ?? err}`, { level: "error" });
      return false;
    }
    if (settleMs) await sleep(settleMs);
    return true;
  }

  /**
   * A brain was refused for want of memory: stop what is up on the same
   * device and is not one of the brains this quest needs now (`keep`). True
   * when something was stopped, so the start is worth one more try.
   */
  async function makeRoom(b, ctx, why) {
    if (!ctx?.keep) return false;
    const gpu = /MiB of VRAM/.test(why);
    const out = brains.list().filter((x) => x.id !== b.id && !ctx.keep.has(x.id) && x.status === "ready" && ((x.device ?? "gpu") !== "cpu") === gpu);
    if (!out.length) return false;
    const ids = out.map((x) => x.id);
    log(ctx.quest, `${b.id} does not fit beside ${ids.join(" and ")}: ${ids.length === 1 ? "it stops" : "they stop"} first (${clip(why, 160)})`, { brain: b.id, stopped: ids });
    let any = false;
    for (const id of ids) any = (await stopBrain(id, ctx.quest, `${id} stops to make room for ${b.id}`)) || any;
    return any;
  }

  /** Have the brain serving; wait out another caller's load instead of racing it. */
  async function ready(b, ctx = null) {
    let madeRoom = false;
    for (let i = 0; i < 600; i++) {
      const cur = entryOf(b.id) ?? b;
      if (cur.status === "ready") return cur;
      if (cur.status === "loading") {
        await sleep(Math.min(coolPollMs, 1000));
        continue;
      }
      if (onGpu(b.id)) await coolEnough(null, `starting ${b.id}`, ctx?.meter);
      try {
        await brains.start(b.id);
        return entryOf(b.id) ?? b;
      } catch (err) {
        const why = String(err?.message);
        if (/already loading/.test(why)) continue;
        // what does not fit beside this quest's brains is stopped first, once
        if (!madeRoom && /Needs \d+ MiB of (?:VRAM|RAM)/.test(why) && (await makeRoom(b, ctx, why))) {
          madeRoom = true;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`brain "${b.id}" did not become ready`);
  }

  /** a brain that is gone: the watchdog stopped it, or it died */
  const isGone = (err) => /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Loading model/i.test(String(err?.message ?? err));

  /**
   * One brain call, paced by the heat; when the brain is gone (the heat
   * watchdog stops every brain at 93 C), wait for the card to cool, start it
   * again and try once more, so a cutoff costs a pause and not the worker.
   * With a quest's context the call is metered: what it generated counts
   * against the quest's token cap, and no call starts once a cap is passed.
   */
  const chatWith = (id, signal, ctx = null) => async (messages, opts) => {
    const m = ctx?.meter ?? null;
    // every brain call is a turn of the quest's; the one past the cap is never made
    if (m) m.turns++;
    if (overCap(m, ctx?.quest)) throw new Error(m.over);
    if (onGpu(id)) await coolEnough(signal, id, m);
    let reply;
    try {
      reply = await brains.chat(id, messages, opts);
    } catch (err) {
      if (!isGone(err) || signal?.aborted) throw err;
      bus.emit("log", { text: `${id} is gone (${String(err?.message ?? err).slice(0, 80)}); waiting for the card to cool, then starting it again` });
      if (onGpu(id)) await coolEnough(signal, `restarting ${id}`, m);
      await ready(entryOf(id) ?? { id, status: "idle" }, ctx);
      reply = await brains.chat(id, messages, opts);
    }
    if (m) {
      m.tokens += generatedTokens(reply);
      overCap(m, ctx?.quest);
    }
    return reply;
  };

  /** One titan call: the plan (at most `max` tasks), or the whole quest as one task. */
  async function plan(quest, titan, { max = MAX_TASKS, ctx = null } = {}) {
    const span = max <= 1 ? "exactly 1 task" : `1 to ${max} tasks`;
    const messages = [
      {
        role: "system",
        content: `${persona}\n\nYou plan a quest into ${span} a small worker can each do alone with file tools in a short context. The tasks together must cover every part of the quest: nothing it asks may be left out, so an ask with two parts (an "and", a "then") becomes two tasks. But two tasks must never write the same file: when the quest produces one file, it is one task. Each task has a finish line (how we know it is done) and a rubric of 3 to 5 lines its report will be judged against. Answer with only JSON:\n{"tasks":[{"task":"...","finish":"...","rubric":["...","...","..."]}]}`,
      },
      { role: "user", content: `Quest${quest.by ? ` from ${quest.by}` : ""}:\n${questAsk(quest)}` },
    ];
    try {
      const reply = await chatWith(titan.id, null, ctx)(messages, { maxTokens: 800 + Math.max(0, max - MAX_TASKS) * 270, thinking: false, json_schema: planSchema(max) });
      const tasks = parsePlan(reply?.content, max);
      if (tasks) return { tasks, parsed: true };
      log(quest.id, "the plan did not parse; the whole quest is one task");
    } catch (err) {
      log(quest.id, `the titan could not plan: ${err?.message ?? err}; the whole quest is one task`);
    }
    return { tasks: fallbackPlan(questAsk(quest)), parsed: false };
  }

  /** Wait for room on the GPU; {cap: 0} when it stays hot past coolMaxMs or the quest is stopped. */
  async function waitForRoom(quest, parallel, signal, m = null) {
    const start = Date.now();
    let said = false;
    try {
      for (;;) {
        const hw = hardware?.readHardware?.() ?? null;
        const cap = workerCap(hw, { footprintMiB, parallel });
        if (cap > 0 || signal.aborted || Date.now() - start >= coolMaxMs) return { cap, hw };
        if (!said) {
          said = true;
          waitBegins(m);
          log(quest.id, `the GPU junction is at ${hw?.heat?.junctionC ?? "?"} C: no Promethean starts until it cools`, { hot: true });
        }
        await sleep(coolPollMs, signal);
      }
    } finally {
      if (said) waitEnds(m);
    }
  }

  /** a quest's context when a caller brings none: its tier as it resolves now, unmetered */
  function bareCtx(quest) {
    const r = resolveFor(quest ?? {});
    return { quest: quest?.id ?? null, meter: null, keep: null, tier: r.tier ?? {}, legacy: !!r.legacy, named: r.judgeNamed ?? null };
  }

  /**
   * Who judges a report: the tier's named judge, else the Titan for a
   * Promethean and the Promethean's brain for an Offspring, else any other
   * brain of the tier; never the author, never one in `exclude`. With no
   * tiers, any other brain in the catalogue is the last resort.
   */
  function judgeFor(report, ctx, exclude = []) {
    const t = ctx.tier ?? {};
    const order = [ctx.named, report.tier === "offspring" ? t.promethean : t.titan, t.titan, t.promethean, t.offspring];
    for (const id of order) {
      if (!id || id === report.brain || exclude.includes(id)) continue;
      const b = entryOf(id);
      if (b) return b;
    }
    return ctx.legacy ? (brains.list().find((b) => b.id !== report.brain && !exclude.includes(b.id)) ?? null) : null;
  }

  const reportForJudge = (report) => ({ status: report.status, summary: report.summary, verified: report.verified, inferred: report.inferred, files: report.files, open: report.open, caught: report.caught });
  const powerOf = (id) => {
    const b = id ? entryOf(id) : null;
    const vram = Number(b?.vramMiB);
    const ram = Number(b?.ramMiB);
    const n = Math.max(Number.isFinite(vram) ? vram : 0, Number.isFinite(ram) ? ram : 0);
    return n > 0 ? n : null;
  };
  const markJudgement = (j, report) => {
    const judgePower = powerOf(j.by);
    const authorPower = powerOf(report.brain);
    if (judgePower == null || authorPower == null || judgePower >= authorPower) return j;
    return { ...j, advisory: true, advisoryReason: `${j.by} is smaller than ${report.brain} by catalogue memory (${judgePower} < ${authorPower} MiB)` };
  };

  /** A different brain than the author judges one finished report, in one call. */
  async function judge(quest, report, rubric, ctx = null, { exclude = [] } = {}) {
    ctx ??= bareCtx(quest);
    const judgeBrain = judgeFor(report, ctx, exclude);
    const base = { id: report.id, tier: report.tier, author: report.brain, by: judgeBrain?.id ?? null };
    if (!judgeBrain) return markJudgement({ ...base, score: 0, verdict: "unjudged", note: "no other brain to judge with" }, report);
    const messages = [
      {
        role: "system",
        content: `${persona}\n\nYou judge a worker's report against its rubric; you are not the worker and you trust only what its verified list backs. Score 0 to 1, 1 when every rubric line is met. Answer with only JSON:\n{"score": 0.0, "verdict": "pass" | "weak" | "fail", "note": "one or two sentences"}`,
      },
      {
        role: "user",
        content: `Task:\n${report.task}\n\nRubric:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nReport:\n${JSON.stringify(reportForJudge(report), null, 1)}`,
      },
    ];
    try {
      await ready(judgeBrain, ctx);
      const reply = await chatWith(judgeBrain.id, null, ctx)(messages, { maxTokens: 400, thinking: false, json_schema: JUDGE_SCHEMA });
      const j = parseJudgement(reply?.content);
      if (j) return markJudgement({ ...base, ...j }, report);
      return markJudgement({ ...base, score: 0, verdict: "unjudged", note: "the judge's answer did not parse" }, report);
    } catch (err) {
      return markJudgement({ ...base, score: 0, verdict: "unjudged", note: `the judge failed: ${err?.message ?? err}` }, report);
    }
  }

  /**
   * The judge brain judges every report in one batch (several calls on the
   * same loaded brain when there are more than BATCH_MAX): Map of report id ->
   * {score, verdict, note}. A report the answer leaves out is not in the map.
   */
  async function judgeBatch(quest, leaves, judgeBrain, ctx, first = new Map()) {
    const out = new Map();
    for (let at = 0; at < leaves.length; at += BATCH_MAX) {
      if (ctx.meter?.ac?.signal.aborted) break;
      const part = leaves.slice(at, at + BATCH_MAX);
      const blocks = part.map((r, i) => {
        const f = first.get(r.id);
        const rubric = (r.rubric ?? DEFAULT_RUBRIC).map((line, k) => `${k + 1}. ${line}`).join("\n");
        const brief = { status: r.status, summary: clip(r.summary, 600), verified: few(r.verified), inferred: few(r.inferred), files: few(r.files, 12), open: few(r.open), caught: few(r.caught) };
        return `### Report ${at + i + 1}: ${r.id} (${r.tier} on ${r.brain ?? "?"})\nTask:\n${clip(r.task, 600)}\n\nRubric:\n${rubric}\n\nReport:\n${JSON.stringify(brief, null, 1)}${f && f.verdict !== "unjudged" ? `\n\nFirst judged by ${f.by}: ${f.score} ${f.verdict}${f.note ? ` (${clip(f.note, 160)})` : ""}` : ""}`;
      });
      const messages = [
        {
          role: "system",
          content: `${persona}\n\nYou judge every report of a quest in one pass, each against its own rubric; you are none of the workers and you trust only what a report's verified list backs. Score each 0 to 1, 1 when every line of its rubric is met. Answer with only JSON, one judgement per report, by its id:\n{"judgements":[{"id":"...","score":0.0,"verdict":"pass" | "weak" | "fail","note":"one or two sentences"}]}`,
        },
        { role: "user", content: `Quest:\n${clip(quest.task, 2000)}\n\n${blocks.join("\n\n")}` },
      ];
      try {
        const reply = await chatWith(judgeBrain.id, null, ctx)(messages, { maxTokens: 200 + 160 * part.length, thinking: false, json_schema: BATCH_SCHEMA });
        const got = parseJudgements(reply?.content);
        part.forEach((r, i) => {
          const j = got.get(r.id) ?? got.get(r.id.replace(/^wisp:/, "")) ?? got.get(String(at + i + 1));
          if (j) out.set(r.id, j);
        });
        if (!got.size) log(quest.id, `${judgeBrain.id}'s batch of judgements did not parse`, { judge: judgeBrain.id });
      } catch (err) {
        log(quest.id, `${judgeBrain.id} could not judge the batch: ${err?.message ?? err}`, { judge: judgeBrain.id });
      }
    }
    return out;
  }

  /** The judge brain writes the quest's answer from the reports and their judgements; null when it cannot. */
  async function synthesize(quest, tasks, leaves, judged, judgeBrain, ctx) {
    const scoreOf = new Map(judged.map((j) => [j.id, j]));
    const lines = leaves.map((r) => {
      const j = scoreOf.get(r.id);
      return `- ${r.id} (${r.tier}): ${r.status}. ${clip(r.summary, 500)}${r.files?.length ? ` Files: ${few(r.files, 12).join(", ")}.` : ""}${r.open?.length ? ` Open: ${few(r.open, 4).join("; ")}.` : ""}${j ? ` ${j.advisory ? "Advisory judgement" : "Judged"} ${j.score} ${j.verdict}${j.note ? `: ${clip(j.note, 200)}` : ""}.` : ""}`;
    });
    const messages = [
      {
        role: "system",
        content: `${persona}\n\nYou write the answer of a quest from its workers' reports and your judgements of them. Say what was done, what was checked and what was only believed, what is still open or failed, and name the files. Plain prose in a few short paragraphs, no JSON, nothing the reports do not back.`,
      },
      { role: "user", content: `Quest${quest.by ? ` from ${quest.by}` : ""}:\n${clip(quest.task, 2000)}\n\nPlan:\n${tasks.map((t, i) => `${i + 1}. ${clip(t.task, 300)}`).join("\n")}\n\nReports:\n${lines.join("\n")}` },
    ];
    try {
      const reply = await chatWith(judgeBrain.id, null, ctx)(messages, { maxTokens: 1200, thinking: false });
      const text = String(reply?.content ?? "").trim();
      if (text) return text;
      log(quest.id, `${judgeBrain.id} wrote no answer; the summary lists the reports instead`, { judge: judgeBrain.id });
    } catch (err) {
      log(quest.id, `${judgeBrain.id} could not write the answer: ${err?.message ?? err}; the summary lists the reports instead`, { judge: judgeBrain.id });
    }
    return null;
  }

  /** Run one quest to its report. Never throws. */
  async function run(quest) {
    const ac = new AbortController();
    const { signal } = ac;
    active.set(quest.id, ac);
    const started = now();
    const meter = newMeter(ac);
    const ctx = { quest: quest.id, meter, keep: new Set(), tier: {}, legacy: false, named: null };
    const reports = [];
    const phases = [];
    let splits = 0;
    let tasks = [];
    let res = null; // the tier as resolved (runtime/sizes.mjs)
    let titan = null; // the Titan's brain, when the tier has one
    let ck = null; // the Titan's agent id
    let alone = null; // an exclusive brain this quest loaded, to give the GPU back at the end
    const foundUp = new Set(); // exclusive brains that were already serving when the quest began: left as found
    let answer = null;
    let report;
    const spawned = (data) => bus.emit("agent.spawned", { kind: "wisp", arm: "chronos", vendor: "chronos", quest: quest.id, ...data });
    const phase = (name, brain) => {
      phases.push({ phase: name, brain, at: now().toISOString() });
      bus.emit("quest.phase", { id: quest.id, phase: name, brain });
    };
    const chat = (id, sig = null) => chatWith(id, sig, ctx);
    /** the brain of one part of the tier */
    const brainOf = (part) => {
      const id = ctx.tier?.[part];
      const b = id ? entryOf(id) : null;
      if (!b) throw new Error(res?.legacy ? `no brain in slot "${slots[part] ?? part}" for the ${part}` : `size ${res?.size}: no brain${id ? ` ${id}` : ""} for the ${part}`);
      return b;
    };
    const exclusive = (id) => !!(id && entryOf(id)?.exclusive);
    /** take a resolved tier: the quest carries it, the caps follow it, and the bus hears quest.running */
    const take = (r, extra = {}) => {
      res = r;
      ctx.tier = r.tier ?? {};
      ctx.legacy = !!r.legacy;
      ctx.named = r.judgeNamed ?? null;
      quest.size = r.size;
      quest.tier = r.tier;
      meter.caps = { ...questCaps(r.caps, quest.budget), turns: maxTurns };
      bus.emit("quest.running", { id: quest.id, size: r.size, tier: r.tier, ...extra });
    };
    // a running-time cap is noticed even while a long call is in flight; the workers halt at their next turn
    const watch = setInterval(() => overCap(meter, quest.id), 1000);
    watch.unref?.();
    const stoppedSummary = (rest) => (meter.over ? `Stopped: ${meter.over}; ${rest}.` : null);

    try {
      const first = resolveFor(quest);
      // an l asked of Lite runs as m: the quest, quest.running and the report say so (runtime/sizes.mjs CUT_SIZES)
      if (first.downgraded) quest.downgraded = first.downgraded;
      take(first, first.downgraded ? { downgraded: first.downgraded } : {});
      if (first.auto && !first.legacy) log(quest.id, `sized ${first.auto.size} by the task's words (${first.auto.why.join(", ") || "an ordinary ask"})`, { size: first.auto.size, auto: true });
      for (const note of first.notes) log(quest.id, note, { size: first.size, fallback: true });
      if (!first.ok) throw new Error(`no size can run: ${first.why}`);
      // an exclusive brain already serving is left as found, unless the quest before left it up for this one
      for (const id of new Set([ctx.tier.titan, ctx.tier.judge])) if (exclusive(id) && entryOf(id)?.status === "ready" && keptFor !== id) foundUp.add(id);
      keptFor = null;

      // Three phases when the quest is large, or when its Titan (or judge) is alone on the GPU.
      const phased = () => exclusive(ctx.tier.titan) || exclusive(ctx.tier.judge);
      const tierIds = () => [ctx.tier.titan, ctx.tier.promethean, ctx.tier.offspring, ctx.tier.judge].filter(Boolean);

      // before sizes a quest could not run without a Titan: with no tiers that still holds
      if (res.legacy && !ctx.tier.titan) brainOf("titan");

      // ---- plan: the Titan, when the tier has one; one that will not load falls back a size ----
      while (ctx.tier.titan) {
        titan = brainOf("titan");
        ck = agentId("titan");
        ctx.keep = new Set(phased() ? [titan.id] : tierIds());
        phase("plan", titan.id);
        spawned({ id: ck, tier: "titan", parent: null, brain: titan.id, task: quest.task, depth: 0 });
        try {
          await ready(titan, ctx);
          if (exclusive(titan.id)) alone = titan.id;
          break;
        } catch (err) {
          const next = res.legacy || signal.aborted ? null : resolveFor(quest, { below: res.size });
          if (!next?.ok) throw err;
          const why = clip(err?.message ?? err, 200);
          log(quest.id, `the Titan ${titan.id} would not load (${why}): falling back to size ${next.size}`, { id: ck, size: next.size, fallback: true });
          bus.emit("agent.done", { id: ck, status: "blocked", tier: "titan", parent: null, quest: quest.id, summary: `BLOCKED: ${titan.id} would not load: ${why}` });
          titan = null;
          ck = null;
          take(next, { fallback: true });
        }
      }
      if (titan) {
        const planned = await plan(quest, titan, { max: res.caps.maxTasks ?? MAX_TASKS, ctx });
        tasks = planned.tasks;
        log(quest.id, `${planned.parsed ? "planned" : "took the quest as"} ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${tasks.map((t) => t.task.slice(0, 60)).join(" | ")}`, { id: ck });
      } else {
        tasks = fallbackPlan(questAsk(quest));
        log(quest.id, `size ${res.size}: no plan, the whole quest is one task for one Promethean`);
      }

      const worker = brainOf("promethean");
      if (signal.aborted) {
        report = gather({ status: "stopped", summary: stoppedSummary("no Promethean had started") ?? "Stopped before any Promethean started." });
      } else {
        // ---- work: an exclusive Titan steps aside first (the first swap) ----
        const inPhases = phased();
        if (inPhases) {
          if (titan && exclusive(titan.id)) await stopBrain(titan.id, quest.id, `the plan is made: ${titan.id} is alone on the GPU, so it stops while the workers run`);
          ctx.keep = new Set([ctx.tier.promethean, ctx.tier.offspring].filter(Boolean));
        }
        phase("work", worker.id);
        const { cap, hw } = await waitForRoom(quest, parallelOf(worker), signal, meter);
        if (cap === 0 && !signal.aborted) {
          report = gather({ status: "blocked", summary: `No Promethean could start: the GPU junction is at ${hw?.heat?.junctionC ?? "?"} C and stayed hot for ${Math.round(coolMaxMs / 1000)} s.` });
        } else if (signal.aborted) {
          report = gather({ status: "stopped", summary: stoppedSummary("no Promethean had started") ?? "Stopped before any Promethean started." });
        } else {
          await ready(worker, ctx);
          const toolbox = tools ?? createTools({ root });
          log(quest.id, `up to ${cap} Promethean${cap === 1 ? "" : "s"} at once (${hw?.vram?.freeMiB ?? "?"} MiB free)`, { id: ck, cap });
          // who halves a fallen task: the Titan, or the Promethean's brain when there is no Titan or it is down
          const splitter = titan && !inPhases ? titan : worker;

          const runWorker = async ({ id, task, rubric, tier, depth, parent, state = "", brain = worker }) => {
            const r = await runPromethean({
              id,
              task,
              rubric,
              tier,
              parent,
              depth,
              state,
              budget,
              persona,
              brain: brain.id,
              quest: quest.id,
              chat: chat(brain.id, signal),
              tools: toolbox,
              bus,
              signal,
              maxTokens,
            });
            r.rubric = rubric;
            if (r.status !== "fell" || signal.aborted) return [r];
            if (depth >= maxDepth) {
              r.status = "blocked";
              r.blocked = `fell at depth ${depth}, the cap: ${r.why}`;
              log(quest.id, `${r.id} fell at depth ${depth}, the cap: blocked`, { id: r.id });
              return [r];
            }
            const halves = await splitTask({ task, report: r, chat: chat(splitter.id) });
            const children = halves.map((half) => ({ id: agentId("offspring"), task: half }));
            splits++;
            bus.emit("agent.split", { id: r.id, children: children.map((c) => c.id), depth: depth + 1, quest: quest.id, why: r.why });
            const state2 = partialState(r);
            const small = await ready(brainOf("offspring"), ctx);
            const results = await Promise.all(children.map((c) => runWorker({ id: c.id, task: c.task, rubric, tier: "offspring", depth: depth + 1, parent: r.id, state: state2, brain: small })));
            return [r, ...results.flat()];
          };

          // Tasks that name the same file run one after another, each starting from the
          // last one's report, so two workers never overwrite each other's file.
          const together = sharesAFile(tasks);
          if (together) log(quest.id, `the tasks name the same file (${together}): they run one after another`, { id: ck });
          let before = null;
          const trees = together
            ? await pool(tasks, 1, async (t) => {
                const tree = await runWorker({ id: agentId("promethean"), task: t.task, rubric: t.rubric, tier: "promethean", depth: 0, parent: ck, state: before ?? undefined });
                const last = [tree].flat().at(-1);
                before = last ? `${last.id} already did: ${last.summary ?? ""}${last.files?.length ? ` (files: ${last.files.join(", ")})` : ""}` : before;
                return tree;
              })
            : await pool(tasks, cap, (t) => runWorker({ id: agentId("promethean"), task: t.task, rubric: t.rubric, tier: "promethean", depth: 0, parent: ck }));
          reports.push(...trees.flat());

          const leaves = reports.filter((r) => r.status !== "fell");
          const judged = [];
          const said = (j, r, how = "") => log(quest.id, `${j.by ?? "nobody"} judged ${r.id}${how}${j.advisory ? " (advisory)" : ""}: ${j.score} ${j.verdict}${j.note ? `: ${j.note.slice(0, 120)}` : ""}`, { id: r.id, judge: j.by, score: j.score, ...(j.advisory ? { advisory: true } : {}) });
          if (!inPhases) {
            // ---- judge, one report at a time, each by a different brain than its author ----
            if (!signal.aborted && leaves.length) phase("judge", judgeFor(leaves[0], ctx)?.id ?? ctx.tier.judge ?? null);
            for (const r of leaves) {
              if (signal.aborted) break;
              const j = await judge(quest, r, r.rubric ?? DEFAULT_RUBRIC, ctx);
              judged.push(j);
              said(j, r);
            }
          } else {
            const head = ctx.tier.judge ? entryOf(ctx.tier.judge) : null;
            const notHead = head ? [head.id] : [];
            // meanwhile, with the judge down: the Promethean's brain judges the Offspring
            const firstBy = new Map();
            for (const r of leaves) {
              if (signal.aborted) break;
              if (r.tier !== "offspring" || !judgeFor(r, ctx, notHead)) continue;
              const j = await judge(quest, r, r.rubric ?? DEFAULT_RUBRIC, ctx, { exclude: notHead });
              firstBy.set(r.id, j);
              said(j, r, " meanwhile");
            }
            if (!signal.aborted && leaves.length) {
              // ---- judge: the workers stop, the judge loads once more (the second swap) ----
              let loaded = false;
              if (!head) log(quest.id, `size ${res.size}: its judge ${ctx.tier.judge ?? ""} is not in the catalogue: the workers' brains judge each other and no answer is written`, { fallback: true });
              else {
                if (exclusive(head.id)) {
                  for (const id of new Set([ctx.tier.promethean, ctx.tier.offspring])) {
                    if (id && id !== head.id) await stopBrain(id, quest.id, `the work is done: ${id} stops so ${head.id} can load alone`);
                  }
                }
                ctx.keep = new Set([head.id]);
                phase("judge", head.id);
                try {
                  await ready(head, ctx);
                  if (exclusive(head.id)) alone = head.id;
                  loaded = true;
                } catch (err) {
                  log(quest.id, `the judge ${head.id} would not load (${clip(err?.message ?? err, 200)}): the workers' brains judge each other and no answer is written`, { judge: head.id, fallback: true });
                }
              }
              // the judge never judges what it wrote itself
              const own = head ? leaves.filter((r) => r.brain === head.id) : [];
              const batch = loaded && !signal.aborted ? await judgeBatch(quest, leaves.filter((r) => !own.includes(r)), head, ctx, firstBy) : new Map();
              if (!loaded || own.length) ctx.keep = new Set(tierIds());
              for (const r of leaves) {
                const b = batch.get(r.id);
                const f = firstBy.get(r.id);
                let j;
                if (b) j = markJudgement({ id: r.id, tier: r.tier, author: r.brain, by: head.id, ...b, ...(f && f.verdict !== "unjudged" ? { first: { by: f.by, score: f.score, verdict: f.verdict, ...(f.advisory ? { advisory: true } : {}) } } : {}) }, r);
                else if (f) j = f;
                else if (signal.aborted) continue;
                else if (!loaded || own.includes(r)) j = await judge(quest, r, r.rubric ?? DEFAULT_RUBRIC, ctx, { exclude: notHead });
                else j = markJudgement({ id: r.id, tier: r.tier, author: r.brain, by: head.id, score: 0, verdict: "unjudged", note: "the judge's batch left this report out" }, r);
                judged.push(j);
                if (j !== f) said(j, r);
              }
              if (loaded && !signal.aborted) {
                answer = await synthesize(quest, tasks, leaves, judged, head, ctx);
                if (answer) log(quest.id, `${head.id} wrote the answer from ${plural(leaves.length, "report")}`, { id: ck, judge: head.id });
              }
            }
          }
          const status = questStatus(reports, judged, { stopped: signal.aborted });
          const tally = `${leaves.length} report${leaves.length === 1 ? "" : "s"} from ${reports.length} agent${reports.length === 1 ? "" : "s"}, ${splits} split${splits === 1 ? "" : "s"}. ${leaves.map((r) => `${r.id}: ${r.status}, ${r.summary}`).join(" ")}`.trim();
          const summary = `${status === "stopped" ? (stoppedSummary(`${plural(reports.length, "agent")} had run`) ?? `Stopped by the owner after ${reports.length} agent${reports.length === 1 ? "" : "s"}.`) : (answer ?? tally)}${advisorySummary(judged)}`;
          report = gather({ status, summary, judged, tally: answer ? tally : null });
        }
      }
    } catch (err) {
      report = gather({ status: "failed", summary: `The quest failed: ${err?.message ?? err}` });
    }
    clearInterval(watch);

    // An exclusive brain this quest loaded gives the GPU back, unless it was serving
    // before the quest began or the next quest in line plans on it.
    if (alone && !foundUp.has(alone) && isUp(alone)) {
      const next = queue?.next?.() ?? null;
      if (next && next.tier?.titan === alone) {
        keptFor = alone;
        log(quest.id, `${alone} stays up: the next quest (${next.id}) plans on it`, { brain: alone });
      } else await stopBrain(alone, quest.id, `the quest is over: ${alone} stops and gives the GPU back`);
    }

    function gather({ status, summary, judged = [], tally = null }) {
      const seconds = (ms) => Math.round(ms / 100) / 10;
      return {
        id: quest.id,
        status,
        summary,
        size: res?.size ?? quest.size ?? null,
        ...(quest.downgraded ? { downgraded: quest.downgraded } : {}),
        tier: res?.tier ?? null,
        plan: tasks,
        titan: { id: ck, brain: titan?.id ?? null },
        reports: reports.map((r) => ({ ...r, rubric: undefined })),
        judged,
        splits,
        ...(answer ? { answer, tally } : {}),
        ...(meter.over ? { why: meter.over } : {}),
        usage: { tokens: meter.tokens, turns: meter.turns, seconds: seconds(ranMs(meter)), waitedSeconds: seconds(meter.waitedMs) },
        caps: { ...meter.caps },
        phases,
        startedAt: started.toISOString(),
        finishedAt: now().toISOString(),
      };
    }

    try {
      const t = writeTrail({ root, dir, title: `quest ${quest.id}: ${quest.task.slice(0, 60)}`, body: trailBody(quest, report), date: now() });
      report.trail = { file: t.file, name: t.name, hash: t.hash, prev: t.prev };
    } catch (err) {
      log(quest.id, `the trail could not be written: ${err?.message ?? err}`, { level: "error" });
      report.trail = null;
    }
    active.delete(quest.id);
    if (ck) bus.emit("agent.done", { id: ck, status: report.status, tier: "titan", parent: null, quest: quest.id, summary: report.summary.slice(0, 300) });
    bus.emit("quest.done", {
      id: quest.id,
      status: report.status,
      size: report.size,
      tier: report.tier,
      summary: report.summary.slice(0, 300),
      ...(report.why ? { why: report.why } : {}),
      ...(quest.chat ? { chat: quest.chat } : {}),
      report,
      trail: report.trail?.name ?? null,
    });
    return report;
  }

  /** Raise the stop flag of a running quest; true when one was running. */
  function stop(id) {
    const ac = active.get(id);
    if (!ac) return false;
    ac.abort();
    log(id, "stop asked: the workers finish their turn and halt");
    return true;
  }

  /** Take queued quests one at a time until close(). */
  function start(q) {
    if (loop) return loop;
    queue = q;
    closed = false;
    bus.on?.("quest.started", onStarted);
    loop = (async () => {
      while (!closed) {
        const quest = queue.next?.() ?? null;
        if (!quest) {
          await new Promise((resolve) => {
            wake = resolve;
            const t = setTimeout(resolve, 1000);
            t.unref?.();
          });
          wake = null;
          continue;
        }
        quest.status = "running";
        quest.startedAt = Date.now();
        const report = await run(quest);
        quest.status = report.status;
        quest.summary = report.summary;
        quest.report = report;
        if (report.why) quest.why = report.why;
        quest.doneAt = Date.now();
      }
    })();
    return loop;
  }

  function onStarted() {
    wake?.();
  }

  /** Stop the loop and every running quest; resolves when the loop has ended. */
  async function close() {
    closed = true;
    bus.off?.("quest.started", onStarted);
    for (const id of active.keys()) stop(id);
    wake?.();
    await loop;
    loop = null;
  }

  return { run, stop, start, close, judge, plan, resolve: resolveFor, tiers: tierTable, workerCap: (hw, parallel = 1) => workerCap(hw, { footprintMiB, parallel }), running: () => [...active.keys()], trailDir: dir };
}

/** The trail entry's body: the ask, the size and its brains, the plan, every agent, the judgements. */
export function trailBody(quest, report) {
  const lines = [`# Quest ${quest.id}`, "", `**Ask:** ${quest.task}`, "", `**By:** ${quest.by ?? "nobody"}`, ""];
  if (report.size) {
    const t = report.tier ?? {};
    const brains = [t.titan && `Titan ${t.titan}`, t.promethean && `Promethean ${t.promethean}`, t.offspring && `Offspring ${t.offspring}`, t.judge && `judge ${t.judge}`].filter(Boolean);
    lines.push(`**Size:** ${report.size}${brains.length ? ` (${brains.join(", ")})` : ""}`, "");
  }
  lines.push(`**Status:** ${report.status}`, "");
  if (report.why) lines.push(`**Why:** ${report.why}`, "");
  lines.push(`**Summary:** ${report.summary}`, "");
  if (report.plan?.length) {
    lines.push("## Plan", "");
    report.plan.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.task}`, `   - finish line: ${t.finish}`);
      for (const r of t.rubric ?? []) lines.push(`   - rubric: ${r}`);
    });
    lines.push("");
  }
  if (report.reports?.length) {
    lines.push("## Agents", "");
    const byId = new Map(report.judged.map((j) => [j.id, j]));
    for (const r of report.reports) {
      const j = byId.get(r.id);
      lines.push(`- ${r.id} (${r.tier}, ${r.brain ?? "?"}, depth ${r.depth}${r.parent ? `, under ${r.parent}` : ""}): ${r.status}${r.why ? ` (${r.why})` : ""}`);
      lines.push(`  - ${r.summary}`);
      if (r.files?.length) lines.push(`  - files: ${r.files.join(", ")}`);
      if (r.verified?.length) lines.push(`  - verified: ${r.verified.join("; ")}`);
      if (r.inferred?.length) lines.push(`  - inferred: ${r.inferred.join("; ")}`);
      if (r.open?.length) lines.push(`  - open: ${r.open.join("; ")}`);
      if (r.caught?.length) lines.push(`  - caught: ${r.caught.join("; ")}`);
      if (j) lines.push(`  - ${j.advisory ? "advisory judgement" : "judged"} ${j.score} ${j.verdict} by ${j.by ?? "nobody"}${j.note ? `: ${j.note}` : ""}${j.first ? ` (first ${j.first.score} ${j.first.verdict} by ${j.first.by}${j.first.advisory ? ", advisory" : ""})` : ""}`);
    }
    lines.push("");
  }
  if (report.tally) lines.push(`**Tally:** ${report.tally}`, "");
  const used = report.usage ? `; ${report.usage.tokens} tokens generated in ${report.usage.seconds} s${report.usage.waitedSeconds ? ` (and ${report.usage.waitedSeconds} s waiting for a cool card)` : ""}` : "";
  lines.push(`${report.titan?.id ? `Titan ${report.titan.id} on ${report.titan.brain ?? "?"}` : "No Titan"}; ${report.splits ?? 0} split(s)${used}; ${report.startedAt} to ${report.finishedAt}.`);
  return lines.join("\n");
}

