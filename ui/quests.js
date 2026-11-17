// Every task this page knows: GET /quests seeds the list, then the event stream keeps
// it live: quest.queued opens one, the agent.* and log events fill its timeline,
// quest.done closes it. The page renders from what this returns.

export const STAGES = ["plan", "work", "review", "done"];
const ACTIVE = new Set(["queued", "running", "stopping"]);

export function isActive(q) {
  return ACTIVE.has(q?.status);
}

/** The runtime's role names, as the words the page shows. */
export function roleWord(tier, words) {
  if (tier === "titan") return words.planner;
  if (tier === "offspring") return words.helper;
  return words.worker;
}

let brandName = "the service";
/** The name the runtime's own text is rewritten to when it names itself. */
export function setTextBrand(name) {
  if (name) brandName = name;
}

/** A model id as a size the page may show: qwen3.5-9b -> 9B. Never the vendor. */
export function modelSize(id) {
  const m = String(id ?? "").match(/(\d+(?:\.\d+)?)b$/i);
  return m ? `${m[1]}B` : "";
}

/**
 * Log lines come from the runtime as written: its internal role names, its model ids and its
 * own name are put in the page's words, so a rebranded page never shows them.
 */
export function plainText(text, words) {
  return String(text ?? "")
    .replace(/\bTitans?\b/gi, words.planner)
    .replace(/\bPrometheans?\b/gi, words.worker)
    .replace(/\bOffspring\b/gi, words.helper)
    .replace(/\bbrain\s+[a-z]+[\d.]*-(\d+(?:\.\d+)?)b\b/gi, (m, n) => `${n}B ${words.model}`)
    .replace(/\b[a-z]+[\d.]*-(\d+(?:\.\d+)?)b\b/gi, (m, n) => `the ${n}B ${words.model}`)
    .replace(/\bbrains\b/gi, `${words.model}s`)
    .replace(/\bbrain\b/gi, words.model)
    .replace(/\bChronos(?: Lite)?\b/g, brandName)
    .replace(/\bquests?\b/gi, (m) => (m.toLowerCase().endsWith("s") ? `${words.task}s` : words.task));
}

export function createStore() {
  const quests = new Map();
  const order = []; // newest first

  const get = (id) => {
    let q = quests.get(id);
    if (!q) {
      q = { id, task: "", size: null, status: "queued", at: null, doneAt: null, stage: null, stages: {}, agents: new Map(), timeline: [], summary: "", why: "", downgraded: null, stopAsked: false };
      quests.set(id, q);
      order.unshift(id);
    }
    return q;
  };
  const push = (q, ev, kind, text, extra = {}) => q.timeline.push({ n: ev.n, t: ev.t, kind, text, ...extra });
  const enter = (q, stage, t) => {
    const at = STAGES.indexOf(stage);
    STAGES.forEach((s, i) => {
      if (i < at && q.stages[s] === "active") q.stages[s] = "done";
    });
    q.stages[stage] = stage === "done" ? "done" : "active";
    q.stage = stage;
    q.stageAt = t;
  };

  /** Apply one event; answers the id of the task it touched, or null. */
  function apply(ev, words) {
    const type = ev?.type ?? "";
    const id = type.startsWith("quest.") ? ev.id : ev.quest;
    if (!id) return null;
    if (type === "quest.started" && !quests.has(id)) return null; // quest.queued says the same, with more
    const q = get(id);

    switch (type) {
      case "quest.queued":
      case "quest.started":
        q.task = ev.task ?? q.task;
        q.size = ev.size ?? q.size;
        q.at = q.at ?? ev.t;
        if (!q.timeline.some((x) => x.kind === "queued")) push(q, ev, "queued", `Received, waiting for the card`);
        break;
      case "quest.running":
        q.status = q.stopAsked ? "stopping" : "running";
        q.size = ev.size ?? q.size;
        if (ev.downgraded) q.downgraded = ev.downgraded;
        if (q.size === "s") q.stages.plan = "skipped";
        push(q, ev, "running", `Started as ${sizeWord(q.size, words).toLowerCase()}${ev.downgraded ? " (a larger size was asked for and runs as thorough)" : ""}`);
        if (q.size === "s") enter(q, "work", ev.t);
        break;
      case "quest.phase": {
        const stage = ev.phase === "judge" ? "review" : ev.phase === "plan" ? "plan" : "work";
        enter(q, stage, ev.t);
        const who = ev.phase === "judge" ? `The ${words.planner} reviews the results` : ev.phase === "plan" ? `The ${words.planner} plans the ${words.task}` : `The ${words.worker}s start`;
        push(q, ev, "phase", who, { brain: ev.brain ?? null });
        break;
      }
      case "agent.spawned": {
        if (ev.tier === "titan") break; // the planner is the plan and review stages, not a row
        const parent = q.agents.get(ev.parent);
        const label = parent ? `${parent.label}.${(parent.kids = (parent.kids ?? 0) + 1)}` : String((q.tops = (q.tops ?? 0) + 1));
        const a = { id: ev.id, label, tier: ev.tier, parent: parent ? parent.id : null, depth: ev.depth ?? 0, task: ev.task ?? "", status: "working", brain: ev.brain ?? null, summary: "" };
        q.agents.set(ev.id, a);
        if (q.stage !== "work" && q.stage !== "review") enter(q, "work", ev.t);
        push(q, ev, "spawn", `${cap(roleWord(ev.tier, words))} ${a.label} took a ${words.step}: ${clip(plainText(ev.task, words), 120)}`, { agent: ev.id });
        break;
      }
      case "agent.split": {
        const a = q.agents.get(ev.id);
        if (a) a.status = "split";
        const n = ev.children?.length ?? 0;
        push(q, ev, "split", `${cap(roleWord(a?.tier, words))} ${a?.label ?? short(ev.id)} could not finish${ev.why ? ` (${clip(plainText(ev.why, words), 90)})` : ""} and split it between ${n} ${words.helper}${n === 1 ? "" : "s"}`, { agent: ev.id, warn: true });
        break;
      }
      case "agent.done": {
        const a = q.agents.get(ev.id);
        if (ev.tier === "titan" || !a) break; // the planner, or one whose start this page never saw
        if (a && a.status !== "split") a.status = ev.status === "fell" ? "fell" : ev.status ?? "done";
        if (a) a.summary = ev.summary ?? "";
        if (ev.status === "fell") break; // the split that follows says it
        push(q, ev, "agent", `${cap(roleWord(ev.tier ?? a?.tier, words))} ${a?.label ?? short(ev.id)} ${statusVerb(ev.status)}${ev.summary ? `: ${clip(plainText(ev.summary, words), 140)}` : ""}`, { agent: ev.id, warn: ev.status !== "done" });
        break;
      }
      case "quest.done":
        q.status = ev.status ?? "done";
        q.summary = plainText(ev.summary ?? "", words);
        q.why = plainText(ev.why ?? "", words);
        q.size = ev.size ?? q.size;
        q.doneAt = ev.t;
        if (ev.downgraded) q.downgraded = ev.downgraded;
        for (const a of q.agents.values()) if (a.status === "working") a.status = q.status === "stopped" ? "stopped" : "done";
        STAGES.forEach((s) => {
          if (q.stages[s] === "active") q.stages[s] = "done";
        });
        q.stages.done = q.status === "done" ? "done" : "ended";
        q.stage = "done";
        push(q, ev, "end", endLine(q.status, words), { warn: q.status !== "done" });
        break;
      case "log": {
        if (!ev.text) break;
        const judged = ev.judge && Number.isFinite(ev.score);
        push(q, ev, judged ? "judged" : "log", judged ? `Reviewed ${labelOf(q, ev.id, words)}: ${scoreWord(ev.score)}` : plainText(ev.text, words), { agent: ev.id ?? null, score: judged ? ev.score : undefined, minor: !judged });
        break;
      }
      default:
        return null;
    }
    return id;
  }

  /** Fill a task from GET /quests/:id when the stream started after it was queued. */
  function merge(row, words) {
    if (!row?.id) return;
    const q = get(row.id);
    q.task = q.task || row.task || "";
    q.size = q.size ?? row.size ?? null;
    q.at = q.at ?? row.at ?? null;
    // the list may be a moment older than the stream: never move a finished task back, or a stopping one to running
    const stale = (!isActive(q) && ACTIVE.has(row.status)) || (q.status === "stopping" && row.status === "running");
    if (row.status && !stale) q.status = row.status;
    if (row.report?.summary || row.summary) q.summary = plainText(row.report?.summary ?? row.summary, words);
    if (row.report?.files) q.files = row.report.files;
    if (row.downgraded) q.downgraded = row.downgraded;
    if (!isActive(q) && q.stage !== "done") {
      q.stage = "done";
      q.stages.done = q.status === "done" ? "done" : "ended";
    }
    order.sort((a, b) => (quests.get(b).at ?? 0) - (quests.get(a).at ?? 0));
  }

  return {
    apply,
    merge,
    get: (id) => quests.get(id) ?? null,
    list: () => order.map((id) => quests.get(id)),
    markStopping(id) {
      const q = quests.get(id);
      if (!q) return;
      q.stopAsked = true;
      if (isActive(q)) q.status = "stopping";
    },
  };
}

export function sizeWord(size, words) {
  return size === "s" ? words.quick : size === "m" ? words.thorough : size === "auto" || !size ? words.auto : size;
}

export function statusWord(status) {
  return { queued: "Waiting", running: "Running", stopping: "Stopping", done: "Done", partial: "Partly done", stopped: "Stopped", blocked: "Blocked", failed: "Failed", fell: "Could not finish", split: "Split", working: "Working" }[status] ?? cap(status ?? "unknown");
}

function statusVerb(s) {
  return { done: "finished", partial: "finished part of it", blocked: "is blocked", stopped: "stopped", failed: "failed" }[s] ?? `ended (${s})`;
}

function endLine(s, words) {
  if (s === "done") return `The ${words.task} is done`;
  if (s === "stopped") return `The ${words.task} was stopped`;
  if (s === "partial") return `The ${words.task} ended partly done`;
  return `The ${words.task} ended: ${statusWord(s).toLowerCase()}`;
}

function labelOf(q, id, words) {
  const a = q.agents.get(id);
  return a ? `${roleWord(a.tier, words)} ${a.label}` : short(id);
}

function scoreWord(score) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return `${pct} out of 100${score >= 0.5 ? ", passed" : ", below the bar"}`;
}

const cap = (s) => String(s ?? "").replace(/^./, (c) => c.toUpperCase());
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** a short handle for an agent id: its last four characters */
export const short = (id) => `#${String(id ?? "").replace(/[^a-z0-9]/gi, "").slice(-4)}`;
