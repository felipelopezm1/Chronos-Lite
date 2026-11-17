// Parts more than one view draws: a quest's phase strip, its tier brains, its agents as lines,
// the status and size chips, the size picker and a meter. Every word comes from lib/words.js,
// so the brand's vocabulary holds wherever they are drawn.

import { h, fill, chip, dot } from "./dom.js";
import { W, shortBrain, sizeLetter, roleWord, the, many, cap, phaseName, plainText } from "./words.js";
import { state } from "../store.js";

const PHASES = ["plan", "work", "judge"];
const phaseNote = (p) =>
  ({
    plan: `${the("planner")} plans the ${many("step")}`,
    work: `${cap(many("worker"))} and their ${many("helper")} do the ${many("step")}`,
    judge: `the reports are judged and the answer is written`,
  })[p];

const STATUS_TONE = { running: "hot", queued: "mute", done: null, partial: "warn", failed: "bug", blocked: "bug", fell: "bug", stopped: "mute", stopping: "hot" };

export function statusChip(status) {
  const s = status ?? "queued";
  return chip(s, STATUS_TONE[s] ?? null, `status: ${s}`);
}

export function sizeChip(size, title) {
  const l = sizeLetter(size);
  return l ? chip(l, "size", title ?? `size ${l}: which ${many("model")} do the work`) : null;
}

/**
 * The three phases of a quest, the current one lit: plan, work, judge. A size S quest has no
 * plan and no judge of its own (one worker on the 4B), so those cells are struck out. null when
 * the quest tells no phase and is not running.
 */
export function phaseStrip(q, { compact = false } = {}) {
  if (!q) return null;
  const live = q.status === "running" || q.status === "stopping";
  if (!q.phase && !live) return null;
  const small = String(q.size).toLowerCase() === "s";
  const phase = q.phase ?? (small && live ? "work" : null);
  const at = PHASES.indexOf(phase);
  return h(
    `div.phases${compact ? ".compact" : ""}`,
    { role: "img", "aria-label": phase ? `phase: ${phaseName(phase)}${q.phaseBrain ? ` on the ${shortBrain(q.phaseBrain)}` : ""}` : "no phase yet" },
    PHASES.map((p, i) => {
      const none = small && p !== "work";
      const on = live && p === phase;
      const was = !none && ((live && at > i) || (!live && !!phase));
      return h(
        `span.phase${on ? ".on" : ""}${was ? ".was" : ""}${none ? ".none" : ""}`,
        { title: none ? `a size ${sizeLetter("s")} ${W.task} has no ${phaseName(p)}` : phaseNote(p) },
        h("span.phase-word", phaseName(p)),
        on && q.phaseBrain ? h("span.phase-brain", shortBrain(q.phaseBrain)) : null,
      );
    }),
  );
}

/** The brains of a tier as labelled chips; the one that works now is lit. */
export function tierRow(tier, { lit = null } = {}) {
  if (!tier) return null;
  const cells = ["titan", "promethean", "offspring", "judge"].map((r) => [r, tier[r]]).filter(([, id]) => id);
  if (!cells.length) return null;
  return h(
    "div.tier",
    cells.map(([role, id]) => h("span.tier-cell", h("span.tiny", roleWord(role)), chip(shortBrain(id) || W.model, lit && lit === id ? "hot" : null, `${roleWord(role)}: the ${shortBrain(id)} ${W.model}`))),
  );
}

const AGENT_WORD = { done: "ok", running: "…", fell: "fell", blocked: "blocked", partial: "partial", failed: "failed", stopped: "stopped" };

/** A quest's agents as lines: ▸ role brain task … ok. From the live events, else from its report. */
export function agentLines(q, { max = 12 } = {}) {
  if (!q) return null;
  let list = q.agents?.size ? [...q.agents.values()] : [];
  if (!list.length && q.report?.reports?.length) {
    list = [];
    if (q.report.titan?.id) list.push({ id: q.report.titan.id, tier: "titan", brain: q.report.titan.brain, task: q.task, status: q.status });
    for (const r of q.report.reports) list.push({ id: r.id, tier: r.tier, brain: r.brain, task: r.task, status: r.status, summary: r.summary, parent: r.parent });
  }
  if (!list.length) return null;
  const shown = list.slice(-max);
  return h(
    "ul.agents",
    list.length > shown.length ? h("li.tiny", `${list.length - shown.length} earlier`) : null,
    shown.map((a) => {
      const bad = a.status === "fell" || a.status === "blocked" || a.status === "failed";
      return h(
        `li.agent${a.status === "running" ? ".live" : ""}${bad ? ".bad" : ""}${a.tier === "offspring" ? ".sub" : ""}`,
        { title: `${plainText(a.task ?? "")}${a.summary ? `\n${plainText(a.summary)}` : a.last ? `\n${plainText(a.last)}` : ""}` },
        h("span.agent-mark", { "aria-hidden": "true" }, a.tier === "offspring" ? "↳" : "▸"),
        h("span.tiny.agent-tier", roleWord(a.tier)),
        h("span.tiny.agent-brain", shortBrain(a.brain)),
        h("span.agent-task", plainText(a.status === "running" && a.last ? a.last : (a.task ?? a.id))),
        a.split ? h("span.tiny", `split ${a.split}`) : null,
        h("span.tiny.agent-status", AGENT_WORD[a.status] ?? a.status ?? ""),
      );
    }),
  );
}

/**
 * The size picker: auto, S and M as a radio group (Lite has no L). A size /health says is not
 * ok is greyed out with its reason as the title.
 *   sizePicker({ value, onPick, label }) -> { el, value(), set(v), refresh() }
 */
export function sizePicker({ value = "auto", onPick = () => {}, label = "size" } = {}) {
  const el = h("div.seg", { role: "radiogroup", "aria-label": label });
  const SIZES = ["auto", "s", "m"];
  let cur = SIZES.includes(String(value).toLowerCase()) ? String(value).toLowerCase() : "auto";
  function refresh() {
    fill(
      el,
      SIZES.map((s) => {
        const info = s === "auto" ? null : state.health?.sizes?.[s];
        const off = s !== "auto" && info?.ok === false;
        const who = !info?.tier ? "" : info.tier.titan ? `the ${shortBrain(info.tier.titan)} plans, the ${shortBrain(info.tier.promethean)} works` : `the ${shortBrain(info.tier.promethean)} works alone`;
        const title = s === "auto" ? `${W.auto}: the size is picked from what the ${W.task} asks` : off ? plainText(info.why ?? "this size cannot run now") : `size ${sizeLetter(s)}${who ? `: ${who}` : ""}`;
        return h(
          `button.seg-cell${cur === s ? ".on" : ""}`,
          {
            type: "button",
            role: "radio",
            "aria-checked": cur === s ? "true" : "false",
            "aria-disabled": off ? "true" : null,
            tabindex: cur === s ? "0" : "-1",
            title,
            dataset: { size: s },
            onclick: () => {
              if (off) return;
              cur = s;
              refresh();
              onPick(cur);
              el.querySelector("[aria-checked='true']")?.focus();
            },
            onkeydown: (e) => {
              if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
              e.preventDefault();
              const cells = [...el.querySelectorAll("[role='radio']:not([aria-disabled='true'])")];
              const i = cells.indexOf(e.currentTarget);
              cells[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : cells.length - 1)) % cells.length]?.click();
            },
          },
          sizeLetter(s),
        );
      }),
    );
  }
  refresh();
  return {
    el,
    value: () => cur,
    set(v) {
      cur = SIZES.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : "auto";
      refresh();
    },
    refresh,
  };
}

/** A labelled meter: label, a bar with an optional mark, a value. */
export function meter(label) {
  const fillEl = h("i");
  const bar = h("div.bar", fillEl);
  const v = h("span.meter-v", "—");
  const k = h("span.tiny.meter-k", label);
  const el = h("div.meter", k, bar, v);
  let mark = null;
  return {
    el,
    label: (text) => (k.textContent = text),
    set(share, text, tone = "") {
      fillEl.style.width = `${Math.max(0, Math.min(100, (share || 0) * 100)).toFixed(1)}%`;
      fillEl.className = tone;
      v.textContent = text;
      el.classList.toggle("heat", tone === "heat");
    },
    mark(share, title) {
      if (share == null) {
        mark?.remove();
        mark = null;
        return;
      }
      if (!mark) {
        mark = h("span.bar-mark");
        bar.append(mark);
      }
      mark.title = title ?? "";
      mark.style.left = `${(share * 100).toFixed(1)}%`;
    },
  };
}

export { dot };
