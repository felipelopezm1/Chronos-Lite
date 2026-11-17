// Events in words. Every view that lists events (now, loom, record) says them the same way: one
// sentence, the family the type belongs to (which colours its chip), the context it opens (a
// quest) and how much weight it carries. The words themselves are the brand's (ui/brand.js):
// the default brand says them as Chronos does (quest, the Titan, a Promethean), a company's
// brand in its own (task, the planner, a worker). Nothing the runtime calls itself inside
// (its role names, its model ids, its own name) reaches the page in a rebranded one.

import { dur } from "./time.js";
import { DEFAULT_WORDS } from "../brand.js";

/** The words on show: replaced in place by setWords when /edition is read. */
export const W = { ...DEFAULT_WORDS };
let brandName = "Chronos Lite";
let chronosWords = true;

/** Take the brand's words and name; every sentence after this says them. */
export function setWords(words, name, vocabulary = "chronos") {
  Object.assign(W, DEFAULT_WORDS, words ?? {});
  if (name) brandName = name;
  chronosWords = vocabulary === "chronos";
}

export const cap = (s) => String(s ?? "").replace(/^./, (c) => c.toUpperCase());
/** "the Titan" in Chronos's words, "the planner" in a company's: Chronos names its roles like people */
export const the = (key) => `the ${chronosWords && ["planner", "worker", "helper"].includes(key) ? cap(W[key]) : W[key]}`;
/** "a Promethean", "an Offspring", "a worker", "a helper" */
export const one = (key) => {
  const w = chronosWords && ["planner", "worker", "helper"].includes(key) ? cap(W[key]) : W[key];
  return `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
};
/** the plural of a word that has one (workers, helpers, steps, tasks, models) */
export const many = (key) => W[`${key}s`] ?? `${W[key]}s`;

/** The role word of a tier: titan, promethean, offspring, as the brand says them. */
export function roleWord(tier) {
  if (tier === "titan") return W.planner;
  if (tier === "offspring") return W.helper;
  if (tier === "judge") return W.review;
  return W.worker;
}

/** The families the record filters by, in the order of its chips. */
export const FAMILIES = [
  { id: "quest", prefix: "quest." },
  { id: "agent", prefix: "agent." },
  { id: "brain", prefix: "brain." },
  { id: "heat", prefix: "heat.,throttle." },
  { id: "log", prefix: "log" },
];
/** a family as the page says it */
export const familyLabel = (id) => ({ quest: many("task"), agent: W.agents, brain: many("model"), heat: "heat", log: "log" })[id] ?? id;

export function family(type = "") {
  if (type.startsWith("quest.")) return "quest";
  if (type.startsWith("agent.")) return "agent";
  if (type.startsWith("brain.")) return "brain";
  if (type.startsWith("heat.") || type.startsWith("throttle.") || type.startsWith("hardware.")) return "heat";
  return "log";
}

/** The phase word of a step card: what kind of thing was going on. */
export const phaseWord = (fam) => ({ quest: W.task, agent: W.agents, brain: many("model"), heat: "heat", log: "runtime" })[fam] ?? "runtime";
/** a quest's phase as the page says it: plan, work, and the judging under the brand's word */
export const phaseName = (p) => (p === "judge" ? W.review : p === "quest" ? W.task : p);

/** "9B" from qwen3.5-9b, "0.8B" from qwen3.5-0.8b; "" when it names no size (the vendor never shows). */
export function shortBrain(id) {
  if (!id) return "";
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(String(id).replace(/^[a-z]+\d+(?:\.\d+)?-/i, "")) ?? /-(\d+(?:\.\d+)?)b\b/i.exec(String(id));
  return m ? `${m[1]}B` : "";
}
/** "the 9B brain", "the 9B model" */
export const brainWord = (id) => `the ${shortBrain(id) ? `${shortBrain(id)} ` : ""}${W.model}`;

/** A size as the page says it: S and M in Chronos's words, Quick and Thorough in a company's. */
export function sizeLetter(size) {
  const s = String(size ?? "").toLowerCase();
  if (s === "s") return W.quick.toUpperCase();
  if (s === "m") return W.thorough.toUpperCase();
  if (s === "l") return W.thorough.toUpperCase();
  return s === "auto" ? W.auto.toUpperCase() : "";
}

const clip = (s, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * Text the runtime wrote (a log line, a summary, a reason), in the page's words: its role names,
 * its model ids and its own name become the brand's. In Chronos's words only the name changes.
 */
export function plainText(text) {
  let s = String(text ?? "").replace(/\b(?:the\s+)?(?:brains?\s+)?[a-z]+[\d.]*-(\d+(?:\.\d+)?)b\b/gi, (m, n) => `the ${n}B${chronosWords ? "" : ` ${W.model}`}`);
  if (!chronosWords) {
    s = s
      .replace(/\bTitans?\b/gi, W.planner)
      .replace(/\bPrometheans?\b/gi, (m) => (/s$/i.test(m) ? many("worker") : W.worker))
      .replace(/\bOffspring\b/gi, W.helper)
      .replace(/\bbrains\b/gi, many("model"))
      .replace(/\bbrain\b/gi, W.model)
      .replace(/\bquests\b/gi, many("task"))
      .replace(/\bquest\b/gi, W.task);
  }
  return s.replace(/(built on )?\bChronos(?: Lite)?\b/g, (m, b) => (b ? m : brandName));
}

const PHASE_VERB = { plan: "plans", work: "works", judge: "judges" };
const DONE_WORD = { done: "is done", partial: "is partly done", blocked: "is blocked", fell: "fell", stopped: "stopped", failed: "failed" };
const short = (id) => `#${String(id ?? "").replace(/[^a-z0-9]/gi, "").slice(-4)}`;

/** One event as one sentence. */
export function sentence(ev) {
  const t = ev.type ?? "";
  const task = W.task;
  switch (t) {
    case "quest.queued":
    case "quest.started":
      return `${task} ${ev.id} queued${ev.by ? ` by ${ev.by}` : ""}${ev.size ? `, size ${sizeLetter(ev.size)}` : ""}: ${clip(ev.task)}`;
    case "quest.running":
      return `${task} ${ev.id} runs${ev.size ? ` at size ${sizeLetter(ev.size)}` : ""}${ev.tier?.titan ? ` under ${brainWord(ev.tier.titan)}` : ev.tier?.promethean ? ` on ${brainWord(ev.tier.promethean)}` : ""}${ev.downgraded ? " (an L was asked: it runs as M)" : ""}`;
    case "quest.phase":
      return `${task} ${ev.id}: ${brainWord(ev.brain)} ${PHASE_VERB[ev.phase] ?? ev.phase}`;
    case "quest.done":
      return `${task} ${ev.id} came back ${ev.status ?? "done"}${ev.summary || ev.why ? `: ${clip(plainText(ev.summary || ev.why))}` : ""}`;
    case "agent.spawned":
      return ev.tier === "titan" ? `${the("planner")} takes the ${task} on ${brainWord(ev.brain)}` : `${one(ev.tier === "offspring" ? "helper" : "worker")} breaks off on ${brainWord(ev.brain)}: ${clip(plainText(ev.task), 100)}`;
    case "agent.split":
      return `${cap(one(ev.depth > 1 ? "helper" : "worker"))} could not finish and splits in ${ev.children?.length ?? 2}${ev.why ? `: ${clip(plainText(ev.why), 100)}` : ""}`;
    case "agent.done":
      return `${ev.tier === "titan" ? the("planner") : `${cap(roleWord(ev.tier))} ${short(ev.id)}`} ${DONE_WORD[ev.status] ?? ev.status ?? "is done"}${ev.summary ? `: ${clip(plainText(ev.summary), 110)}` : ""}`;
    case "brain.loading":
      return `${brainWord(ev.id)} loads`;
    case "brain.ready":
      return `${brainWord(ev.id)} is ready`;
    case "brain.waiting":
      return `${brainWord(ev.id)} waits for the graphics card${ev.holder ? ": another service holds it" : ""}`;
    case "brain.failed":
      return `${brainWord(ev.id)} failed to start${ev.why ? `: ${clip(plainText(ev.why))}` : ""}`;
    case "brain.stopped":
      return `${brainWord(ev.id)} stopped`;
    case "brain.switched":
      return `${brainWord(ev.id)} takes the ${ev.slot} seat${ev.from ? ` from ${brainWord(ev.from)}` : ""}`;
    case "hardware.read": {
      const v = ev.vram;
      return `junction ${ev.heat?.junctionC ?? "?"} C${v?.totalMiB ? ` · VRAM ${(v.usedMiB / 1024).toFixed(1)} of ${(v.totalMiB / 1024).toFixed(1)} GiB` : ""}`;
    }
    case "throttle.hold":
      return ev.text ? clip(plainText(ev.text)) : `held: the junction is at ${ev.junctionC} C`;
    case "throttle.release":
      return `runs again: the junction is back at ${ev.junctionC} C`;
    case "heat.cutoff":
    case "heat.clear":
      return ev.text ? clip(plainText(ev.text)) : `${t === "heat.cutoff" ? "heat cutoff" : "the heat cleared"} at ${ev.junctionC} C`;
    case "log":
      return clip(plainText(ev.text ?? ""), 200);
    default:
      return clip(plainText(ev.text ?? ev.summary ?? t), 160);
  }
}

/** The context an event belongs to: "q:<quest>", or null. */
export function contextOf(ev) {
  const t = ev.type ?? "";
  if (t.startsWith("quest.") && ev.id) return `q:${ev.id}`;
  if (ev.quest) return `q:${ev.quest}`;
  return null;
}

/** How an event weighs: hot (the accent), heat, bug (an error), or plain. */
export function toneOf(ev) {
  const t = ev.type ?? "";
  if (t === "throttle.hold" || t === "heat.cutoff") return "heat";
  if (t === "brain.failed" || ev.level === "error" || (t === "quest.done" && (ev.status === "failed" || ev.status === "blocked"))) return "bug";
  if (t === "quest.running" || t === "quest.phase" || t === "quest.queued" || t === "brain.ready") return "hot";
  return null;
}

export { dur };
