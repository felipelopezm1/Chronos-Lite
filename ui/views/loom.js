// The loom: the rock Loom (ui/loom.js) for one quest, filling the view. Carried
// from Chronos's ui/views/loom.js; Lite has no conversations, so the quest is
// the one the hash names, else the newest, and the Loom draws the brand's words.
//
//   the quest     the one in the context (#/loom/q:<id>), else the newest quest
//                 of all, which the view follows as new ones arrive.
//   the stones    the quest's agents, replayed from this session's events (or
//                 from the agents the store knows when its events are gone),
//                 then live: only the focused quest's events reach the Loom;
//                 the heat reaches it whatever the quest.
//   the head      which quest it is, the Loom's count line and its demo link.
//
// mount returns `demo` beside enter and leave: lite.demo() (ui/app.js) shows
// this view and plays the Loom's scripted quest on a cleared stage. On leave
// the Loom stops drawing (pause) and on enter it measures and draws again.
//
// The view contract: mount(root, api) -> { enter(context), leave() }.

import { h, fill } from "../lib/dom.js";
import { statusChip, sizeChip } from "../lib/parts.js";
import { mountLoom } from "../loom.js";
import { state, on, notify, quests } from "../store.js";
import { W, the, many, roleWord, shortBrain, plainText } from "../lib/words.js";
import { contextChip, plainLine } from "./record.js";

/** what reaches the Loom whatever quest it shows */
const ALWAYS = new Set(["hardware.read", "throttle.hold", "throttle.release", "heat.cutoff", "heat.clear"]);
/** after the demo, the picture it left stays this long before the quest comes back */
const DEMO_LINGER_MS = 6000;

const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** an event of quest `id`: its quest.* events and its agents' events and lines */
function belongs(ev, id) {
  if (!id) return false;
  if (ev.type.startsWith("quest.")) return ev.id === id;
  if (ev.type.startsWith("agent.") || ev.type === "log") return ev.quest === id;
  return false;
}

export function mount(root, api) {
  root.classList.add("vw", "view-loom");

  let shown = false;
  let context = null;
  let focus = null; // the quest id on the stage
  let follow = false; // true when no context names a quest: the newest one is shown
  let demoing = null; // the demo's promise while it plays
  let stale = false; // the stage shows what the demo left, not the quest
  let linger = null;

  const countEl = h("span.tiny.loom-count", { role: "status" });
  const demoEl = h("button.v-link.loom-demo", { type: "button" }, "demo");
  const questEl = h("div.loom-quest");
  const canvas = h("canvas.loom-canvas", { role: "img" });
  const title = h("span.v-title");
  const sub = h("span.tiny.v-sub");

  root.append(h("header.v-head", title, sub, h("span.v-head-right", countEl, demoEl)), questEl, h("div.loom-stage", canvas));

  let brandName = api?.brand?.()?.name ?? "Chronos Lite";
  /** the words the view and the Loom say, again whenever the brand is read */
  function relabel() {
    title.textContent = W.loom;
    sub.textContent = `the ${W.agents} of a ${W.task} as stones off ${the("planner")}`;
    demoEl.title = `play a scripted ${W.task}: two ${many("worker")}, a split, a heat climb; no ${W.model} needed`;
    canvas.setAttribute("aria-label", `the ${W.loom}: ${the("planner")} and the stones its ${W.task} breaks off`);
  }
  relabel();
  on("@brand", (brand) => {
    relabel();
    brandName = brand?.name ?? brandName;
    loom.relabel();
    paintQuest();
  });

  const loom = mountLoom(canvas, {
    on: (type, fn) => on(type, (ev) => (ALWAYS.has(type) || (!demoing && belongs(ev, focus))) && fn(ev)),
    count: countEl,
    demo: demoEl,
    words: {
      get name() {
        return brandName;
      },
      get titan() {
        return the("planner");
      },
      get quest() {
        return W.task;
      },
      get workers() {
        return many("worker");
      },
      tier: (t) => roleWord(t),
      brain: (id) => shortBrain(id) || W.model,
      text: (t) => plainText(t),
    },
  });

  // ---- which quest --------------------------------------------------------------------------

  function pick(ctx) {
    if (ctx?.startsWith("q:")) return { id: ctx.slice(2), follow: false };
    return { id: quests.list()[0]?.id ?? null, follow: true };
  }

  /** put quest `id` on a cleared stage, its story so far replayed */
  function stage(id) {
    clearTimeout(linger);
    stale = false;
    focus = id;
    loom.clear();
    if (id) {
      const told = state.log.filter((ev) => belongs(ev, id));
      if (told.length) for (const ev of told) loom.handle(ev);
      else replayAgents(state.quests.get(id));
    }
    paintQuest();
  }

  /** a quest whose events are not in this session: its agents as the store knows them */
  function replayAgents(q) {
    if (!q) return;
    if (q.status === "running") loom.handle({ type: "quest.started", id: q.id, task: q.task });
    for (const a of q.agents?.values?.() ?? []) loom.handle({ type: "agent.spawned", id: a.id, tier: a.tier, parent: a.parent, brain: a.brain, quest: q.id, task: a.task });
    for (const a of q.agents?.values?.() ?? []) {
      if (a.last) loom.handle({ type: "log", id: a.id, quest: q.id, text: a.last });
      if (a.status && a.status !== "running") loom.handle({ type: "agent.done", id: a.id, status: a.status, quest: q.id });
    }
    if (q.status !== "running" && q.status !== "queued") loom.handle({ type: "quest.done", id: q.id, status: q.status });
  }

  function paintQuest() {
    if (demoing || stale) {
      fill(questEl, h("span.tiny.loom-quest-k", "the demo"), h("span.loom-task", demoing ? `a scripted ${W.task}: no ${W.model} is asked` : `what the demo left: the ${W.task} comes back in a moment`));
    } else if (!focus) {
      fill(questEl, plainLine(`no ${W.task} has run yet: ${the("planner")} waits for one`));
    } else {
      const q = state.quests.get(focus);
      const label = follow ? `the newest ${W.task}` : `the ${W.task} picked`;
      fill(
        questEl,
        h("span.tiny.loom-quest-k", label),
        contextChip(`q:${focus}`, api),
        q ? statusChip(q.status) : null,
        q ? sizeChip(q.size) : null,
        h("span.loom-task", { title: q?.task ?? "" }, q?.task ? cut(q.task, 160) : `this ${W.task} is not known here`),
      );
    }
    const q = focus ? state.quests.get(focus) : null;
    notify("view", { view: "loom", live: !!demoing || q?.status === "running" });
  }

  // ---- live -----------------------------------------------------------------------------------

  // the Loom hears its own events first; this follows the newest quest and keeps the head true
  for (const type of ["quest.queued", "quest.started"]) {
    on(type, (ev) => {
      if (follow && !demoing && !ev.replayed && ev.id !== focus) stage(ev.id);
    });
  }
  on("@quests", (id) => {
    if (demoing) return;
    if (follow && !focus && quests.list().length) return stage(quests.list()[0].id);
    if (!id || id === focus) paintQuest();
  });

  // ---- the demo -------------------------------------------------------------------------------

  function demo() {
    if (demoing) return demoing;
    clearTimeout(linger);
    loom.clear();
    demoing = loom.demo().finally(() => {
      demoing = null;
      stale = true;
      paintQuest();
      linger = setTimeout(() => !demoing && stage(focus), DEMO_LINGER_MS);
    });
    paintQuest();
    return demoing;
  }
  // the Loom answers a press on its demo link itself; the view's demo clears the stage first
  root.addEventListener(
    "click",
    (e) => {
      if (!e.target.closest?.(".loom-demo")) return;
      e.preventDefault();
      e.stopPropagation();
      demo();
    },
    true,
  );

  return {
    loom,
    demo,
    enter(ctx) {
      shown = true;
      context = ctx ?? null;
      loom.resume();
      if (demoing) return;
      const next = pick(context);
      follow = next.follow;
      if (next.id !== focus || stale) stage(next.id);
      else paintQuest();
      if (next.id && !state.quests.get(next.id)?.task) quests.load(next.id);
    },
    leave() {
      shown = false;
      loom.pause();
    },
    get shown() {
      return shown;
    },
  };
}
