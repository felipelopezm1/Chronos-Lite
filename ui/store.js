// What the page knows, built only from the event stream (and GET /quests/:id for a
// report): the tasks with their steps and timeline, and the models' states.

const ROLE = { titan: "planner", promethean: "worker", offspring: "helper", judge: "planner" };
export const STAGES = ["queued", "plan", "work", "review", "done"];
const FINAL = new Set(["done", "partial", "blocked", "stopped", "failed"]);

export const isFinal = (status) => FINAL.has(status);

/** Make runtime text read in this page's words: no inner names, no vendor model ids. */
export function plainText(text, words, brandName) {
  return String(text ?? "")
    .replace(/\btitans?\b/gi, (m) => (m.endsWith("s") ? `${words.planner}s` : words.planner))
    .replace(/\bprometheans?\b/gi, (m) => (m.endsWith("s") ? `${words.worker}s` : words.worker))
    .replace(/\boffspring\b/gi, words.helper)
    .replace(/\b[a-z]+[\d.]*-(\d+(?:\.\d+)?)b\b/gi, (m, n) => `the ${n}B ${words.model}`)
    .replace(/\bbrains\b/gi, `${words.model}s`)
    .replace(/\bbrain\b/gi, words.model)
    .replace(/\bChronos(?: Lite)?\b/g, brandName);
}

/** A model id as a size the page may show: qwen3.5-9b -> 9B. */
export function modelSize(id) {
  const m = String(id ?? "").match(/(\d+(?:\.\d+)?)b$/i);
  return m ? `${m[1]}B` : "";
}

export function createStore({ words, brandName }) {
  const say = (text) => plainText(text, words, brandName);
  const tasks = new Map();
  const models = new Map();
  const state = { tasks, models, hardware: null, card: null, lastEventAt: 0 };

  const ensure = (id, t) => {
    let q = tasks.get(id);
    if (!q) {
      q = { id, task: "", size: null, asked: null, status: "queued", at: t, doneAt: null, stage: "queued", agents: new Map(), counters: {}, timeline: [], summary: "", why: "", downgraded: null, stopping: false, report: null, scores: [] };
      tasks.set(id, q);
    }
    return q;
  };

  const add = (q, ev, kind, text, extra = {}) => q.timeline.push({ n: ev.n, t: ev.t, kind, text, ...extra });

  const advance = (q, stage) => {
    if (STAGES.indexOf(stage) > STAGES.indexOf(q.stage)) q.stage = stage;
  };

  const label = (q, agent) => {
    if (agent.role === "planner") return words.planner;
    q.counters[agent.role] = (q.counters[agent.role] ?? 0) + 1;
    return `${words[agent.role]} ${q.counters[agent.role]}`;
  };

  /** Apply one event; answers the task id it touched, if any. */
  function apply(ev) {
    if (!ev || typeof ev.type !== "string") return null;
    state.lastEventAt = ev.t ?? Date.now();
    const type = ev.type;

    if (type.startsWith("brain.") && ev.id) {
      const m = models.get(ev.id) ?? { id: ev.id, role: null, status: "stopped" };
      const st = type.slice(6);
      m.status = { loading: "loading", ready: "ready", stopped: "stopped", failed: "failed", waiting: "waiting", switched: "ready" }[st] ?? m.status;
      if (ev.why) m.why = ev.why;
      models.set(ev.id, m);
      return null;
    }
    if (type === "hardware.read") {
      state.hardware = ev;
      return null;
    }

    const qid = type.startsWith("quest.") ? ev.id : ev.quest;
    if (!qid) return null;
    const q = ensure(qid, ev.t);

    switch (type) {
      case "quest.queued":
      case "quest.started":
        if (ev.task) q.task = ev.task;
        if (ev.size) q.size = ev.size;
        if (type === "quest.queued") add(q, ev, "queued", "Received and queued.");
        break;
      case "quest.running":
        q.status = "running";
        if (ev.size) q.size = ev.size;
        if (ev.downgraded) q.downgraded = ev.downgraded;
        advance(q, q.size === "s" ? "work" : "plan");
        add(q, ev, "running", "Started.");
        break;
      case "quest.phase": {
        const stage = { plan: "plan", work: "work", judge: "review" }[ev.phase];
        if (stage) advance(q, stage);
        add(q, ev, "phase", { plan: `The ${words.planner} is breaking it into ${words.step}s.`, work: `${cap(words.worker)}s are on it.`, judge: `The ${words.planner} is reviewing the results.` }[ev.phase] ?? `Phase: ${ev.phase}`);
        break;
      }
      case "agent.spawned": {
        const role = ROLE[ev.tier] ?? "worker";
        const a = { id: ev.id, role, parent: ev.parent ?? null, depth: ev.depth ?? 0, task: ev.task ?? "", status: "running", summary: "", model: modelSize(ev.brain), score: null };
        a.label = label(q, a);
        q.agents.set(ev.id, a);
        if (role !== "planner") advance(q, "work");
        add(q, ev, "spawn", role === "planner" ? `The ${words.planner} took the ${words.task}.` : `${cap(a.label)} started${a.task ? `: ${say(a.task)}` : "."}`, { agent: ev.id });
        break;
      }
      case "agent.split": {
        const a = q.agents.get(ev.id);
        if (a) a.status = "split";
        add(q, ev, "split", `${cap(a?.label ?? `A ${words.step}`)} could not finish${ev.why ? ` (${say(ev.why)})` : ""} and was split into ${ev.children?.length ?? 2} smaller parts for ${words.helper}s.`, { agent: ev.id });
        break;
      }
      case "agent.done": {
        const a = q.agents.get(ev.id);
        if (a) {
          if (a.status !== "split") a.status = ev.status ?? "done";
          a.summary = say(ev.summary ?? "");
        }
        if (a?.role === "planner") break;
        add(q, ev, ev.status === "done" ? "done-step" : "fell", `${cap(a?.label ?? `A ${words.step}`)} ${verb(ev.status)}${ev.summary ? `: ${say(ev.summary)}` : "."}`, { agent: ev.id });
        break;
      }
      case "log":
        if (ev.judge !== undefined && ev.id) {
          advance(q, "review");
          const a = q.agents.get(ev.id);
          if (a && Number.isFinite(ev.score)) a.score = ev.score;
          add(q, ev, "review", `Reviewed ${a?.label ?? `a ${words.step}`}: ${Number.isFinite(ev.score) ? `score ${ev.score}` : "no score"}.`, { agent: ev.id });
        } else if (ev.text) {
          add(q, ev, "note", say(ev.text));
        }
        break;
      case "quest.done":
        q.status = ev.status ?? "done";
        q.doneAt = ev.t;
        q.stopping = false;
        q.stage = "done";
        if (ev.size) q.size = ev.size;
        q.summary = say(ev.summary ?? ev.report?.summary ?? q.summary);
        q.why = say(ev.why ?? "");
        if (ev.report) q.report = ev.report;
        for (const a of q.agents.values()) if (a.status === "running") a.status = q.status === "stopped" ? "stopped" : a.status;
        add(q, ev, "final", `Finished: ${statusWord(q.status)}.`);
        break;
      default:
        return null;
    }
    return qid;
  }

  /** Fill a task from GET /quests/:id (a task whose start fell out of the event ring). */
  function merge(row) {
    if (!row?.id) return;
    const q = ensure(row.id, row.at ?? Date.now());
    if (row.task && !q.task) q.task = row.task;
    if (row.size && !q.size) q.size = row.size;
    if (row.status && (isFinal(row.status) || q.status === "queued")) q.status = row.status;
    if (row.report) q.report = row.report;
    if (!q.summary && (row.summary || row.report?.summary)) q.summary = row.summary || row.report.summary;
    if (isFinal(q.status)) q.stage = "done";
  }

  /** Seed the models from /health's brains list. */
  function setModels(list = []) {
    for (const b of list) {
      const m = models.get(b.id) ?? { id: b.id };
      m.role = ROLE[b.role] ?? b.role ?? m.role ?? null;
      m.status = b.status ?? m.status ?? "stopped";
      m.present = b.present !== false;
      models.set(b.id, m);
    }
  }

  return { state, apply, merge, setModels, say };
}

const cap = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

function verb(status) {
  return { done: "finished", partial: "partly finished", fell: "could not finish", blocked: "is blocked", stopped: "stopped", failed: "failed" }[status] ?? `ended (${status})`;
}

export function statusWord(status) {
  return { queued: "Queued", running: "Running", done: "Done", partial: "Partly done", blocked: "Blocked", stopped: "Stopped", failed: "Failed", split: "Split", fell: "Could not finish" }[status] ?? cap(status ?? "unknown");
}
