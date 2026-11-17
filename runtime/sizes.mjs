// Wisp sizes: which brains do a quest's work. In Chronos Lite a quest is s or
// m (or "auto", which a plain rule on the task's words settles, never a model
// call). Full Chronos's l is not here: a quest that asks for it, outright or as
// "[size:l]", is accepted and runs as m, with a note that says so
// (docs/decisions/0003). Each size is a tier in forge/brains.json `tiers`:
//
//   "m": { "titan": "<brain id>", "promethean": "<id>", "offspring": "<id>", "judge": "<id>"?,
//          "maxTasks": 3, "tokens": 64000, "seconds": 2700, "note": "..." }
//
// `titan` plans, splits and judges; a tier with no Titan (s) plans nothing and
// its Promethean's brain leads. `judge` names who judges; left out, the Titan
// judges the Prometheans and the Promethean's brain the Offspring, and never
// the author. A judge smaller than the author by the catalogue's memory figures
// is advisory: its score is recorded, but it cannot demote a finished report.
// A tier whose lead brain is not on disk falls back to the next smaller tier,
// and says so.
//
// Everything here is pure: the server stamps a quest with what it resolves to
// when it is queued, the runner resolves again when it takes it.

/** the sizes, smallest first */
export const SIZES = ["s", "m"];

/** sizes full Chronos has and Lite does not, and the size each runs as here */
export const CUT_SIZES = { l: "m" };

/** which brain slot plays which part when no tiers are configured */
export const SLOTS = { titan: "talk", promethean: "promethean", offspring: "offspring" };

const WORDS = { small: "s", medium: "m", large: "l", s: "s", m: "m", l: "l", auto: "auto" };

/** "L", " m ", "auto", "Large" -> "l", "m", "auto", "l"; null for anything else */
export function normalSize(v) {
  if (typeof v !== "string") return null;
  return WORDS[v.trim().toLowerCase()] ?? null;
}

/**
 * The size a task names in its first line, as "[size:l]" anywhere in it or
 * "size: l" at its start, and the task without the marker. This is how a
 * caller that can only send text picks a size.
 */
export function parseSizeMarker(task) {
  const text = String(task ?? "");
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const rest = nl < 0 ? "" : text.slice(nl);
  const pick = (m, line) => ({ size: normalSize(m[1]), task: `${line}${rest}`.trim() });
  let m = /\[\s*size\s*[:=]\s*(auto|s|m|l|small|medium|large)\s*\]/i.exec(first);
  if (m) return pick(m, `${first.slice(0, m.index)}${first.slice(m.index + m[0].length)}`.replace(/\s{2,}/g, " ").trim());
  m = /^\s*size\s*[:=]\s*(auto|s|m|l|small|medium|large)\b[\s,;.:-]*/i.exec(first);
  if (m) return pick(m, first.slice(m[0].length));
  return { size: null, task: text.trim() };
}

const UP = [/\bplan(?:s|ning)?\b/, /\bdesign(?:s|ing)?\b/, /\bcompar(?:e|es|ing|ison)\b/, /\bresearch(?:es|ing)?\b/, /\bwrite (?:a|the) report\b/, /\barchitecture\b/, /\binvestigat(?:e|es|ing)\b/, /\banaly[sz](?:e|es|ing)\b/, /\bevaluat(?:e|es|ing)\b/, /\btrade-?offs?\b/, /\bstrategy\b/];
const DOWN = [/\brenam(?:e|es|ing)\b/, /\blist\b/, /\btag(?:s|ging)?\b/, /\bone[- ]line(?:r)?\b/, /\bone word\b/, /\bcount\b/, /\btypo\b/, /\byes or no\b/];

/** How many things a task asks for: its sentences, its list lines, and what an "and" or a "then" joins. A colon introduces an ask, it does not end one. */
export function countAsks(task) {
  return String(task ?? "")
    .split(/[.?!;]+\s+|\n+|\s+(?:and then|then|and)\s+/i)
    .map((s) => s.trim())
    .filter((s) => /[a-z0-9]/i.test(s)).length;
}

/**
 * The size of a task by a plain rule, never a model call: {size, score, why}.
 * Up: a long task, many asks, words such as plan, design, compare, research,
 * "write a report". Down: a short single ask, words such as rename, list, tag,
 * "one line". Two down, with a single ask, make it s; the rest is m (two up
 * would be l in full Chronos, which Lite does not have).
 */
export function autoSize(task) {
  const text = String(task ?? "").trim();
  const lower = text.toLowerCase();
  const why = [];
  let score = 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const asks = countAsks(text);
  if (words >= 400) {
    score += 2;
    why.push(`${words} words`);
  } else if (words >= 120) {
    score += 1;
    why.push(`${words} words`);
  } else if (words <= 14 && asks <= 1) {
    score -= 1;
    why.push("a short single ask");
  }
  if (asks >= 6) {
    score += 2;
    why.push(`${asks} asks`);
  } else if (asks >= 3) {
    score += 1;
    why.push(`${asks} asks`);
  }
  const up = UP.filter((re) => re.test(lower)).length;
  if (up) {
    score += Math.min(2, up);
    why.push(`${up} word${up === 1 ? "" : "s"} that ask for thought`);
  }
  const down = DOWN.filter((re) => re.test(lower)).length;
  if (down) {
    score -= Math.min(2, down);
    why.push(`${down} word${down === 1 ? "" : "s"} for a small job`);
  }
  // full Chronos makes two points up an l; Lite has no l, so the most a task can rate is m
  const size = score <= -2 && asks <= 1 ? "s" : "m";
  return { size, score, why };
}

/** The brains of a tier as events and quests carry them; `brain` takes the Titan's seat. */
export function tierBrains(t, brain = null) {
  const titan = brain ?? t?.titan ?? null;
  return { titan, promethean: t?.promethean ?? null, offspring: t?.offspring ?? null, judge: t?.judge ?? titan ?? t?.promethean ?? null };
}

/** the brain a tier cannot run without: its Titan, or its Promethean's when it has none */
const leadOf = (t, brain = null) => brain ?? t?.titan ?? t?.promethean ?? null;

/** Why a tier cannot run with this list of brains, as a clause; "" when it can. */
function missing(t, byId, brain = null) {
  const lead = leadOf(t, brain);
  const part = brain || t?.titan ? "Titan" : "Promethean brain";
  if (!lead) return "it names no brain";
  const b = byId.get(lead);
  if (!b) return `its ${part} ${lead} is not in the catalogue`;
  if (b.present === false) return `its ${part} ${lead} is not on disk`;
  return "";
}

/**
 * The tier a quest runs on.
 *
 *   asked   "auto" | "s" | "m" (any case); auto reads the task; "l" runs as m, with a note
 *   tiers   forge/brains.json `tiers`, or null: then every quest is m on the brains in the slots
 *   list    brains.list(): [{id, slot, role, present?}]
 *   brain   a brain id that takes the Titan's seat
 *   below   start under this size (the runner's way down when a Titan would not load)
 *
 * Answers {ok, size, asked, tier, caps, notes, why?}: `notes` are sentences
 * for the log (a fallback, an ignored size); ok is false when no size can run.
 */
export function resolveTier({ asked = "auto", task = "", tiers = null, list = [], slots = SLOTS, brain = null, below = null } = {}) {
  const named = normalSize(typeof asked === "string" ? asked : "auto") ?? "auto";
  const notes = [];
  // a size full Chronos has and Lite does not runs as the size Lite gives it, and says so
  const want = CUT_SIZES[named] ?? named;
  const downgraded = want !== named ? { from: named, to: want } : null;
  if (downgraded) notes.push(`size ${named} is not in Chronos Lite (no ${named} tier, no 27B): the quest runs as size ${want}`);
  const candidates = (list ?? []).filter((b) => !b.alternate);
  const byId = new Map(candidates.map((b) => [b.id, b]));
  if (!tiers || !SIZES.some((s) => tiers[s])) {
    const inSlot = (slot) => (candidates.find((b) => b.slot === slot) ?? candidates.find((b) => b.role === slot))?.id ?? null;
    const tier = tierBrains({ titan: inSlot(slots.titan), promethean: inSlot(slots.promethean), offspring: inSlot(slots.offspring) }, brain);
    if (want !== "auto" && want !== "m") notes.push(`no tiers are configured: size ${want} runs as m`);
    return { ok: true, legacy: true, size: "m", asked: named, tier, caps: { maxTasks: 3 }, notes, ...(downgraded ? { downgraded } : {}) };
  }
  let size = want;
  let auto = null;
  if (want === "auto") {
    auto = autoSize(task);
    size = auto.size;
  }
  let i = SIZES.indexOf(size);
  if (below && SIZES.indexOf(below) >= 0) i = Math.min(i, SIZES.indexOf(below) - 1);
  for (; i >= 0; i--) {
    const t = tiers[SIZES[i]];
    const why = t ? missing(t, byId, brain) : "it is not in the tiers";
    if (!why) break;
    const next = SIZES.slice(0, i)
      .reverse()
      .find((s) => tiers[s]);
    notes.push(next ? `size ${SIZES[i]}: ${why}; falling back to size ${next}` : `size ${SIZES[i]}: ${why}; there is no smaller size to fall back to`);
  }
  if (i < 0) return { ok: false, size, asked: named, tier: null, caps: {}, notes, why: notes.at(-1) ?? "no size can run", ...(auto ? { auto } : {}), ...(downgraded ? { downgraded } : {}) };
  const t = tiers[SIZES[i]];
  return {
    ok: true,
    size: SIZES[i],
    asked: named,
    tier: tierBrains(t, brain),
    judgeNamed: t.judge ?? null,
    synthesis: t.synthesis ?? null,
    caps: { maxTasks: Number(t.maxTasks) || 3, ...(Number(t.tokens) > 0 ? { tokens: Number(t.tokens) } : {}), ...(Number(t.seconds) > 0 ? { seconds: Number(t.seconds) } : {}) },
    notes,
    ...(auto ? { auto } : {}),
    ...(downgraded ? { downgraded } : {}),
  };
}

/**
 * The sizes as GET /health shows them: for each, {ok, why?, fallsTo?, tier,
 * tokens, seconds, maxTasks, note, present}. ok is false when the tier's lead
 * brain is not on disk; `why` then says which smaller size a quest falls back to.
 */
export function describeSizes({ tiers = null, list = [], slots = SLOTS } = {}) {
  const candidates = (list ?? []).filter((b) => !b.alternate);
  const byId = new Map(candidates.map((b) => [b.id, b]));
  const out = {};
  if (!tiers || !SIZES.some((s) => tiers[s])) {
    const r = resolveTier({ asked: "m", tiers: null, list: candidates, slots });
    out.m = { ok: true, tier: r.tier, maxTasks: 3, note: "no tiers are configured: every quest runs on the brains in the slots", present: presence(r.tier, byId) };
    return out;
  }
  for (const size of SIZES) {
    const t = tiers[size];
    if (!t) continue;
    const tier = tierBrains(t);
    const why = missing(t, byId);
    const row = { ok: !why, tier, tokens: t.tokens ?? null, seconds: t.seconds ?? null, maxTasks: t.maxTasks ?? null, note: t.note ?? "", present: presence(tier, byId) };
    if (why) {
      const r = resolveTier({ asked: size, tiers, list, slots });
      row.fallsTo = r.ok ? r.size : null;
      row.why = `${why.replace(/^its /, "the ")}: ${r.ok ? `a size ${size} quest falls back to size ${r.size}` : "no smaller size can run either"}`;
    }
    out[size] = row;
  }
  return out;
}

function presence(tier, byId) {
  const out = {};
  for (const id of new Set(Object.values(tier))) if (id) out[id] = byId.has(id) && byId.get(id).present !== false;
  return out;
}
