// The now view: what is going on, and the ask. Carried from Chronos's ui/views/now.js
// (docs/ui-contract.md 3.3 there). Lite has no conversation to hire from, so the view opens
// on the ask: the text, the size (auto, S, M) and send; typing puts the face in listening.
// Under it the "now" line says the latest event in words, weighed (grey when it is old, the
// ink when it just landed, the accent when it starts something, red only for heat). Then, on
// the left, the steps so far, latest on top; on the right what stands now: a heat hold, the
// quest that runs (plan, work and judge, its brains, its agents, stop), the brains awake or
// loading, the quests that wait.
//
// A step is a run of events that belong together: the events of one quest in one of its
// phases (queued, plan, work, judge, done), or the events of one family (brains, heat, runtime)
// with nothing else between them.

import { h, fill, dot, chip } from "../lib/dom.js";
import { hms, dur, ago, dayOf, when } from "../lib/time.js";
import { W, sentence, family, contextOf, toneOf, shortBrain, sizeLetter, phaseWord, phaseName, plainText, many, the, cap } from "../lib/words.js";
import { statusChip, sizeChip, phaseStrip, tierRow, agentLines, sizePicker } from "../lib/parts.js";
import { firstLine } from "../lib/md.js";
import { state, on, notify, quests } from "../store.js";

const STEP_GAP_MS = 120_000; // a silence this long ends a step
const STEPS_SHOWN = 40;
const FRESH_MS = 12_000; // the now line is news this long

/** The log as steps, oldest first. */
export function stepsOf(log) {
  const steps = [];
  const phase = new Map(); // quest id -> the phase word its events fall under now
  let cur = null;
  for (const ev of log) {
    const ctx = contextOf(ev);
    let word;
    if (ctx?.startsWith("q:")) {
      const qid = ctx.slice(2);
      const t = ev.type;
      if (t === "quest.queued" || t === "quest.started") phase.set(qid, "quest");
      else if (t === "quest.phase" && ev.phase) phase.set(qid, ev.phase);
      else if (t === "quest.done") phase.set(qid, "done");
      else if (t.startsWith("agent.") && (phase.get(qid) ?? "quest") === "quest") phase.set(qid, "work");
      word = phaseName(phase.get(qid) ?? "quest");
    } else word = phaseWord(family(ev.type));
    const key = `${ctx ?? ""}|${word}`;
    if (!cur || cur.key !== key || ev.t - cur.t1 > STEP_GAP_MS) {
      cur = { id: `${ev.n ?? ev.t}-${steps.length}`, key, word, ctx, events: [], t0: ev.t, t1: ev.t, tone: null, head: ev };
      steps.push(cur);
    }
    cur.events.push(ev);
    cur.t1 = ev.t;
    // the step is told by its latest event that is more than a log line
    if (ev.type !== "log" || cur.head.type === "log") cur.head = ev;
    const tone = toneOf(ev);
    if (tone === "heat" || (tone === "bug" && cur.tone !== "heat")) cur.tone = tone;
  }
  return steps;
}

export function mount(root, api) {
  // ---- the ask --------------------------------------------------------------------------
  const askText = h("textarea#ask-text.ask-text", { rows: 3, spellcheck: "true", "aria-describedby": "ask-hint" });
  const askLabel = h("label.tiny.ask-label", { for: "ask-text" });
  const askHint = h("span.tiny.ask-hint#ask-hint");
  const askError = h("p.tiny.ask-error", { role: "alert", hidden: true });
  const sendBtn = h("button.btn.primary.ask-send", { type: "submit" }, "send");
  const picker = sizePicker({ onPick: (s) => (notify("size", s), hint()) });
  const askForm = h(
    "form.panel.ask",
    { novalidate: true },
    h("div.ask-top", askLabel, picker.el),
    askText,
    askError,
    h("div.ask-row", askHint, h("span.tiny.ask-kbd", { "aria-hidden": "true" }, "ctrl enter"), sendBtn),
  );
  function hint() {
    const v = picker.value();
    askHint.textContent =
      v === "s" ? `one ${W.worker} does it straight away, with no plan` : v === "m" ? `${the("planner")} splits it into ${many("step")}, ${many("worker")} do them, ${the("planner")} judges` : `the size is picked from what the ${W.task} asks`;
  }
  function words() {
    askLabel.textContent = `a new ${W.task}`;
    askText.placeholder = `describe the ${W.task} in plain words`;
    picker.refresh();
    hint();
  }
  askText.addEventListener("input", () => {
    notify("typing");
    askError.hidden = true;
  });
  askText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) askForm.requestSubmit();
  });
  askForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = askText.value.trim();
    if (!text) {
      askError.textContent = `describe the ${W.task} first`;
      askError.hidden = false;
      return askText.focus();
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "sending…";
    const r = await quests.send(text, picker.value());
    sendBtn.disabled = false;
    sendBtn.textContent = "send";
    if (r.ok) askText.value = "";
    else {
      askError.textContent = r.status === 0 ? "the service is not answering: your text is kept, send again when it is back" : `it was not accepted: ${r.why}`;
      askError.hidden = false;
    }
  });

  const nowLine = h("p.now-line", { role: "status", "aria-live": "polite" });
  const stepsHead = h("span.tiny");
  const stepsTitle = h("h2.pixel", "so far");
  const stepsList = h("ol.steps");
  const side = h("div.now-side");
  fill(root, h("div.now", askForm, nowLine, h("div.now-grid", h("section.block", { "aria-label": "the steps so far" }, h("header.block-head", stepsTitle, stepsHead), stepsList), side)));

  let shown = false;
  let context = null;
  let timer = null;
  let stepsDirty = true;
  let frame = 0;
  let lastNowKey = "";
  let lastStepsSig = "";
  let lastLatest = null;

  // ---- the now line ---------------------------------------------------------------------

  function paintNow() {
    const ev = state.last;
    if (!ev) {
      if (lastNowKey !== "none") {
        lastNowKey = "none";
        nowLine.dataset.tone = "";
        nowLine.dataset.age = "old";
        fill(nowLine, dot("asleep"), h("span.now-say", state.stream.up ? "nothing has happened yet" : "waiting for the event stream"));
      }
      return;
    }
    const fresh = !ev.replayed && Date.now() - ev.t < FRESH_MS;
    const key = `${ev.n ?? ""}|${ev.t}|${ev.type}|${fresh}|${W.task}`;
    const time = nowLine.querySelector(".now-ago");
    if (key === lastNowKey) {
      if (time) time.textContent = ago(ev.t);
      return;
    }
    lastNowKey = key;
    const tone = toneOf(ev);
    nowLine.dataset.tone = tone === "heat" || tone === "bug" ? tone : fresh && tone ? tone : "";
    nowLine.dataset.age = fresh ? "new" : "old";
    const ctx = contextOf(ev);
    fill(
      nowLine,
      dot(tone === "heat" ? "heat" : fresh ? "on" : "awake"),
      h("span.now-say", { title: sentence(ev) }, sentence(ev)),
      ctx ? h("button.btn.quiet.small", { type: "button", title: `open this ${W.task} on the ${W.loom}`, onclick: () => api.go("loom", ctx) }, "open") : null,
      h("span.tiny.now-ago.num", ago(ev.t)),
    );
  }

  // ---- the steps ------------------------------------------------------------------------

  function paintSteps() {
    stepsDirty = false;
    const all = stepsOf(state.log);
    const total = all.reduce((n, s) => n + s.events.length, 0);
    const span = all.length ? all.at(-1).t1 - all[0].t0 : 0;
    stepsHead.textContent = all.length ? `${all.length} step${all.length === 1 ? "" : "s"} · ${total} ev · ${dur(span)}` : "";
    const rev = all.slice(-STEPS_SHOWN).reverse();
    const liveNow = !!rev[0] && !rev[0].head.replayed && Date.now() - rev[0].t1 < 30_000;
    const sig = rev.map((s) => `${s.id}:${s.events.length}`).join(",") + `|${liveNow}|${W.task}`;
    if (sig === lastStepsSig) return;
    lastStepsSig = sig;
    const fresh = liveNow && rev[0].id !== lastLatest;
    lastLatest = rev[0]?.id ?? null;
    const today = dayOf();
    fill(
      stepsList,
      rev.length
        ? rev.map((s, i) => {
            const latest = i === 0 && liveNow;
            const title = sentence(s.head);
            const inner = [
              h("div.step-head", h("span.tiny.step-time", latest ? "now" : dayOf(s.t0) === today ? hms(s.t0) : when(s.t0)), h("span.tiny.step-word", s.word), h("span.tiny.step-count", `${s.events.length} ev${s.t1 > s.t0 ? ` · ${dur(s.t1 - s.t0)}` : ""}`)),
              h("p.step-body", title),
              s.ctx ? h("span.tiny.step-ctx", `${W.task} · ${s.ctx.slice(2)}`) : null,
            ];
            const fade = latest ? 1 : Math.max(0.85, 1 - i * 0.015);
            return h(
              `li.step${latest ? ".latest" : ""}${latest && fresh ? ".fresh" : ""}`,
              { dataset: s.tone ? { tone: s.tone } : null, style: { opacity: String(fade) } },
              s.ctx ? h("button.step-card", { type: "button", "aria-label": `${s.word} step at ${hms(s.t0)}: ${title}. Open it on the ${W.loom}.`, onclick: () => api.go("loom", s.ctx) }, inner) : h("div.step-card", inner),
            );
          })
        : h("li.tiny.empty", "nothing has happened since this page opened"),
    );
  }

  // ---- what stands now --------------------------------------------------------------------

  function holdBlock() {
    const hold = state.hold;
    const waits = [...state.waiting.values()];
    if (!hold && !waits.length) return null;
    const j = state.hardware?.heat?.junctionC;
    const ev = hold ?? waits[0];
    return h(
      "div.hold",
      { role: "alert" },
      dot("heat"),
      h("span.pixel", hold ? (hold.type === "heat.cutoff" ? "cutoff" : "held") : "waits"),
      h("span.hold-say", sentence(ev)),
      h("span.tiny.num", `${j != null ? `${Math.round(j)} C now · ` : ""}${dur(Date.now() - ev.t)}`),
    );
  }

  /** the quest this view shows: the one that runs (or waits first), else the one picked, else the last one */
  function questNow() {
    const running = quests.running();
    if (running) return { q: running, why: running.status === "queued" ? "next" : "running" };
    const mine = context?.startsWith("q:") ? state.quests.get(context.slice(2)) : null;
    if (mine) return { q: mine, why: "picked" };
    const last = quests.list()[0];
    return last ? { q: last, why: `the last ${W.task}` } : null;
  }

  function questBlock() {
    const pick = questNow();
    if (!pick)
      return h(
        "section.block",
        h("header.block-head", h("h2.pixel", W.task), h("span.tiny", state.questsError ?? "")),
        h("div.panel.block-body", h("p.tiny.empty", `no ${W.task} has been asked yet: describe one above`)),
      );
    const { q, why } = pick;
    const live = q.status === "running" || q.status === "queued" || q.status === "stopping";
    const key = `q:${q.id}`;
    const working = [...(q.agents?.values() ?? [])].filter((a) => a.status === "running").length;
    const lastLine = q.lines?.filter((l) => !l.judge).at(-1)?.text;
    const took = q.startedAt ? (q.finishedAt ?? Date.now()) - q.startedAt : null;
    const sizeNote = q.tier ? `size ${sizeLetter(q.size)}: ${q.tier.titan ? `the ${shortBrain(q.tier.titan)} plans, ` : ""}the ${shortBrain(q.tier.promethean)} works` : undefined;
    const result = q.summary || q.why;
    return h(
      "section.block",
      { "aria-label": `the ${W.task}: ${why}` },
      h("header.block-head", h("h2.pixel", live ? `the ${W.task} that runs` : W.task), h("span.tiny", live ? (q.status === "queued" ? "waits for the runner" : q.status === "stopping" ? "stopping" : `${working} working`) : why)),
      h(
        `article.panel.quest-card${live ? ".live" : ""}`,
        h(
          "div.quest-top",
          h("span.diamond", { "aria-hidden": "true" }),
          h("span.tiny.num", q.id),
          sizeChip(q.size, sizeNote),
          statusChip(q.status),
          q.by ? h("span.tiny", `by ${q.by}`) : null,
          h("span.spacer"),
          took != null ? h("span.tiny.num", { title: "how long it has run" }, dur(took)) : h("span.tiny.num", ago(q.at)),
          live ? h("button.btn.small.heat", { type: "button", dataset: { k: `stop:${q.id}` }, disabled: q.status === "stopping" || null, title: `stop this ${W.task}`, onclick: () => stopQuest(q) }, q.status === "stopping" ? "stopping…" : "stop") : null,
          h("button.btn.small", { type: "button", dataset: { k: `loom:${q.id}` }, title: `see this ${W.task} on the ${W.loom}`, onclick: () => api.go("loom", key) }, W.loom),
          h("button.btn.small", { type: "button", dataset: { k: `rec:${q.id}` }, title: `its report in the ${W.record}`, onclick: () => api.go("record", key) }, W.record),
        ),
        h(
          "div.quest-in",
          h("p.quest-task", q.task || q.id),
          q.downgraded ? h("p.tiny.quest-last", "an L was asked: this edition runs it as M") : null,
          phaseStrip(q),
          tierRow(q.tier, { lit: live ? (q.phaseBrain ?? null) : null }),
          agentLines(q, { max: 8 }),
          live && lastLine ? h("p.tiny.quest-last", { title: plainText(lastLine) }, plainText(lastLine)) : null,
          !live && result ? h("p.quest-sum", firstLine(plainText(result), 320)) : null,
        ),
      ),
    );
  }

  async function stopQuest(q) {
    const r = await quests.stop(q.id);
    if (!r.ok) api.say?.(`it was not stopped: ${r.why ?? "no answer"}`, "bug");
  }

  function brainsBlock() {
    const list = state.brains;
    if (!list.length) return h("section.block", h("header.block-head", h("h2.pixel", many("model")), h("span.tiny", "")), h("div.panel.block-body", h("p.tiny.empty", state.healthError ?? `the service has not named its ${many("model")} yet`)));
    const up = list.filter((b) => b.status === "ready" || b.status === "loading" || b.status === "waiting" || state.loading.has(b.id));
    return h(
      "section.block",
      h("header.block-head", h("h2.pixel", many("model")), h("span.tiny", `${up.length} awake · ${list.length - up.length} asleep`)),
      h(
        "div.panel.rows",
        up.length
          ? up.map((b) => {
              const loading = b.status === "loading" || state.loading.has(b.id);
              const since = state.loading.get(b.id);
              return h(
                "div.row",
                dot(b.status === "waiting" ? "heat" : loading ? "on" : "awake"),
                chip(shortBrain(b.id) || W.model, loading ? "hot" : null),
                h("span.row-main", b.status === "waiting" ? "waits for the card" : loading ? "loads" : "ready"),
                h("span.tiny.row-meta", loading ? (since ? dur(Date.now() - since) : "loading") : ""),
              );
            })
          : h("div.row", dot("asleep"), h("span.row-main", `every ${W.model} is asleep`)),
        h("button.row", { type: "button", dataset: { k: "models" }, onclick: () => api.go("models"), title: `the ${many("model")}, the sizes and the hardware` }, h("span.tiny.row-main", `the ${many("model")}, the sizes and the hardware`), h("span.tiny.row-meta", "open")),
      ),
    );
  }

  function queueBlock() {
    const running = quests.running();
    const waiting = quests
      .list()
      .filter((q) => q.status === "queued" && q !== running)
      .reverse();
    if (!waiting.length) return null;
    return h(
      "section.block",
      h("header.block-head", h("h2.pixel", "waiting"), h("span.tiny", `${waiting.length} ${waiting.length === 1 ? W.task : many("task")}`)),
      h("div.panel.rows", waiting.slice(0, 6).map((q) => h("button.row", { type: "button", dataset: { k: `wait:${q.id}` }, onclick: () => api.go("record", `q:${q.id}`) }, dot("asleep"), sizeChip(q.size), h("span.row-main", q.task || q.id), h("span.tiny.row-meta", ago(q.at))))),
    );
  }

  // the side is drawn again whenever something in it moves, so a press under way is left alone
  let pressing = false;
  side.addEventListener("pointerdown", () => (pressing = true));
  for (const type of ["pointerup", "pointercancel"])
    addEventListener(type, () => {
      if (!pressing) return;
      pressing = false;
      setTimeout(soon, 0);
    });

  function paintSide() {
    if (pressing) return;
    const had = side.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    fill(side, holdBlock(), questBlock(), brainsBlock(), queueBlock());
    if (had) side.querySelector(`[data-k="${CSS.escape(had)}"]`)?.focus();
  }

  // ---- when to paint ------------------------------------------------------------------------

  function paint() {
    frame = 0;
    if (!shown) return;
    paintNow();
    if (stepsDirty) paintSteps();
    paintSide();
  }
  const soon = () => {
    if (shown && !frame) frame = requestAnimationFrame(paint);
  };

  on("@log", () => {
    stepsDirty = true;
    soon();
  });
  for (const topic of ["@quests", "@brains", "@hold", "@stream", "@health"]) on(topic, soon);
  on("@brand", () => {
    words();
    stepsTitle.textContent = "so far";
    stepsDirty = true;
    lastStepsSig = "";
    lastNowKey = "";
    soon();
  });
  words();

  return {
    enter(ctx) {
      context = ctx ?? null;
      shown = true;
      stepsDirty = true;
      lastStepsSig = "";
      paint();
      clearInterval(timer);
      timer = setInterval(() => {
        stepsDirty = true;
        soon();
      }, 1000);
      const mine = context?.startsWith("q:") ? context.slice(2) : null;
      if (mine && !state.quests.get(mine)?.report) quests.load(mine);
    },
    leave() {
      shown = false;
      clearInterval(timer);
      timer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    focusAsk: () => askText.focus(),
  };
}

export { cap };
