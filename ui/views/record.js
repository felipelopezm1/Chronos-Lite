// The record: what went on. Carried from Chronos's ui/views/record.js and cut to what Lite
// keeps (no ledger, no trail: quests and events live in memory, docs/runtime-api.md):
//
//   quests  every quest the service knows (GET /quests), newest first, filtered by state and by
//           words; each opens on its report (GET /quests/:id): what came back, the plan, the
//           agents with what each said, the judging, and the way to it on the loom.
//   events  this session's events (the ring replayed, then live), filtered by family and words;
//           each row opens on the event's own fields.
//
// The view contract: mount(root, api) -> { enter(context), leave() }.

import { h, fill, chip, dot } from "../lib/dom.js";
import { W, FAMILIES, familyLabel, family, sentence, contextOf, toneOf, shortBrain, sizeLetter, roleWord, plainText, many, cap } from "../lib/words.js";
import { hm, hms, dur, dayOf, dayLabel, when } from "../lib/time.js";
import { statusChip, sizeChip, agentLines, tierRow } from "../lib/parts.js";
import { renderMarkdown } from "../lib/md.js";
import { state, on, quests as questStore } from "../store.js";

const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));
const prefixesOf = (id) => FAMILY[id]?.prefix.split(",") ?? [];
const QUEST_STATES = ["running", "done", "partial", "failed", "stopped"];
const SHOWN_MAX = 400;

const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const fullTime = (t) => `${dayLabel(dayOf(t), 0)} ${hms(t)}`;

/** The chip of the quest something belongs to; a press opens it on the loom. */
export function contextChip(ctx, api) {
  if (!ctx) return null;
  const id = ctx.slice(2);
  return h(
    "button.chip.v-ctx",
    {
      type: "button",
      dataset: { fam: "quest" },
      title: `open ${W.task} ${id} on the ${W.loom}`,
      onclick: (e) => {
        e.stopPropagation();
        api?.go?.("loom", ctx);
      },
    },
    cut(id, 20),
  );
}

/** The one line a part says when it has nothing, or when the service could not be read. */
export function plainLine(text, { retry = null, tone = null } = {}) {
  return h("div.tiny.v-empty", { dataset: tone ? { tone } : null }, text, retry ? h("button.v-link", { type: "button", onclick: retry }, "read it again") : null);
}

function showValue(k, v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return /text|summary|why|task/.test(k) ? plainText(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const text = JSON.stringify(v, null, 1).replace(/\n\s*/g, " ");
  return text.length > 360 ? `${text.slice(0, 359)}…` : text;
}

/** One event as a row: its time, its family, one sentence, the quest it belongs to; a press opens its fields. */
export function eventRow(ev, api) {
  const fam = family(ev.type);
  const tone = toneOf(ev);
  const detail = h("div.v-detail", { hidden: true });
  const main = h(
    "button.v-row-main",
    { type: "button", "aria-expanded": "false", title: `${ev.type} · ${fullTime(ev.t)}${ev.n != null ? ` · n ${ev.n}` : ""}` },
    h("span.tiny.v-time", hm(ev.t)),
    h("span.v-fam", { dataset: { fam } }, familyLabel(fam)),
    h("span.v-say", sentence(ev)),
  );
  const row = h("div.v-row", { dataset: { fam, ...(tone ? { tone } : {}), ...(ev.n != null ? { n: ev.n } : {}) } }, main, contextChip(contextOf(ev), api), detail);
  main.addEventListener("click", () => {
    const open = detail.hidden;
    if (open && !detail.firstChild) {
      const fields = Object.entries(ev).filter(([k]) => !["n", "t", "type", "replayed", "report", "tier"].includes(k));
      detail.append(h("div.v-detail-in", h("p.v-detail-say", sentence(ev)), h("dl.v-fields", fields.map(([k, v]) => [h("dt.tiny", k), h("dd", showValue(k, v))]))));
    }
    detail.hidden = !open;
    main.setAttribute("aria-expanded", String(open));
    row.classList.toggle("open", open);
  });
  return row;
}

export function mount(root, api) {
  root.classList.add("vw", "view-record");

  let shown = false;
  let tab = "quests";
  let context = null;

  // ---- the head: the two parts --------------------------------------------------------------
  const tabBtn = new Map();
  const panes = new Map();
  const seg = h("div.v-seg", { role: "tablist", "aria-label": "the parts of the record" });
  for (const id of ["quests", "events"]) {
    const b = h("button.v-seg-cell", { type: "button", role: "tab", id: `rec-tab-${id}`, "aria-selected": "false", "aria-controls": `rec-pane-${id}`, onclick: () => show(id) }, id);
    tabBtn.set(id, b);
    seg.append(b);
    panes.set(id, h(`section.rec-pane.rec-${id}`, { id: `rec-pane-${id}`, role: "tabpanel", "aria-labelledby": `rec-tab-${id}`, hidden: true }));
  }
  const streamDot = dot("asleep");
  const meta = h("span.tiny.v-head-meta");
  const title = h("span.v-title");
  const sub = h("span.tiny.v-sub");
  root.append(h("header.v-head", title, sub, seg, h("span.v-head-right", meta, streamDot)), ...panes.values());

  function relabel() {
    title.textContent = W.record;
    sub.textContent = "what went on";
    tabBtn.get("quests").textContent = many("task");
    tabBtn.get("quests").title = `every ${W.task} and its report`;
    tabBtn.get("events").textContent = "events";
    tabBtn.get("events").title = "this session's events, live";
    qSearch.placeholder = `search the ${many("task")}`;
    search.placeholder = "search the events";
  }

  function paintMeta() {
    const up = state.stream.up;
    streamDot.className = `dot dot-${up ? "awake" : "asleep"}`;
    streamDot.title = up ? "the stream is up: events arrive as they happen" : "the stream is down: it reconnects by itself";
    meta.textContent = `${plural(Q.rows.length, W.task, many("task"))} · ${plural(state.log.length, "event")} this session`;
  }

  function show(id) {
    tab = id;
    for (const [k, b] of tabBtn) b.setAttribute("aria-selected", String(k === id));
    for (const [k, p] of panes) p.hidden = k !== id;
    if (id === "events") paintEvents();
    else paintQuests();
  }

  // ================================================================================================
  // quests
  // ================================================================================================

  const Q = { rows: [], status: null, q: "", open: null, loading: false, error: null, loaded: false };
  const qStates = h("div.rec-fams", { role: "group", "aria-label": "show only those in this state" });
  const qSearch = h("input.v-input.rec-search", { type: "search", "aria-label": "search", spellcheck: "false", autocomplete: "off" });
  const qShown = h("span.tiny.rec-shown", { "aria-live": "polite" });
  const qList = h("div.q-list");
  const qFoot = h("div.rec-foot");
  const qHead = h("div.q-head.tiny", { "aria-hidden": "true" });
  panes.get("quests").append(h("div.rec-main", h("div.rec-filters", qStates, h("div.rec-find", qSearch, qShown)), h("div.rec-list", { tabindex: "0", "aria-label": "newest first" }, qHead, qList, qFoot)));

  function paintQStates() {
    fill(qHead, h("span", "queued"), h("span", `the ${W.task}`), h("span", "by"), h("span", "size"), h("span", "state"), h("span", "ran for"), h("span", W.agents));
    fill(
      qStates,
      h("button.chip.rec-fam.rec-fam-all", { type: "button", "aria-pressed": String(!Q.status), onclick: () => Q.status && ((Q.status = null), paintQuests()) }, "all"),
      QUEST_STATES.map((s) =>
        h(
          "button.chip.rec-fam",
          {
            type: "button",
            dataset: { state: s },
            "aria-pressed": String(Q.status === s),
            onclick: () => {
              Q.status = Q.status === s ? null : s;
              paintQuests();
            },
          },
          s,
        ),
      ),
    );
  }

  qSearch.addEventListener("input", () => {
    Q.q = qSearch.value.trim().toLowerCase();
    paintQuests();
  });

  function ranFor(q) {
    if (q.status === "queued") return "waiting";
    const from = q.startedAt ?? q.at;
    const to = q.finishedAt ?? (q.report?.finishedAt ? Date.parse(q.report.finishedAt) : null) ?? (q.status === "running" ? Date.now() : null);
    if (q.report?.usage?.seconds != null) return dur(q.report.usage.seconds * 1000);
    return from && to ? dur(Math.max(0, to - from)) : "";
  }
  function agentsOf(q) {
    if (q.agents?.size) return q.agents.size;
    const rep = q.report;
    if (rep?.reports?.length) return rep.reports.length + (rep.titan?.id ? 1 : 0);
    const m = /from (\d+) agents?/.exec(q.summary ?? "");
    return m ? Number(m[1]) : null;
  }

  function questRow(q) {
    const open = Q.open === q.id;
    const n = agentsOf(q);
    const detail = h("div.q-detail", { hidden: !open });
    const row = h(
      `div.q-row${open ? ".open" : ""}`,
      { dataset: { id: q.id, status: q.status ?? "queued" } },
      h(
        "button.q-main",
        { type: "button", "aria-expanded": String(open), title: `${q.id}: ${q.task ?? ""}`, onclick: () => toggleQuest(q.id) },
        h("span.tiny.v-time.q-when", when(q.at)),
        h("span.q-task", q.task || q.id),
        h("span.tiny.q-by", q.by ? `by ${q.by}` : "—"),
        h("span.q-size", sizeChip(q.size) ?? h("span.tiny", "—")),
        h("span.q-status", statusChip(q.status)),
        h("span.tiny.q-dur", ranFor(q)),
        h("span.tiny.q-agents", n == null ? "" : plural(n, "agent")),
      ),
      detail,
    );
    if (open) paintQuestDetail(q, detail);
    return row;
  }

  function paintQuests() {
    Q.rows = questStore.list();
    paintQStates();
    paintMeta();
    const rows = Q.rows.filter((q) => (!Q.status || q.status === Q.status) && (!Q.q || `${q.id} ${q.task ?? ""} ${q.by ?? ""} ${q.summary ?? ""}`.toLowerCase().includes(Q.q)));
    fill(qList, rows.map(questRow));
    qShown.textContent = `${rows.length}${rows.length !== Q.rows.length ? ` of ${Q.rows.length}` : ""} shown`;
    if (state.questsError && !Q.rows.length) fill(qFoot, plainLine(`the ${many("task")} could not be read: ${state.questsError}`, { retry: () => questStore.refresh(), tone: "bug" }));
    else if (!Q.rows.length) fill(qFoot, h("div.tiny.v-empty", `no ${W.task} has been asked yet`));
    else if (!rows.length) fill(qFoot, h("div.tiny.v-empty", `none of the ${many("task")} match`));
    else fill(qFoot, h("div.tiny.v-empty", `every ${W.task} the service keeps in memory: ${Q.rows.length}`));
  }

  function toggleQuest(id) {
    Q.open = Q.open === id ? null : id;
    paintQuests();
  }

  const labelled = (label, ...body) => h("div.q-part", h("div.tiny.q-part-k", label), h("div.q-part-v", ...body));

  async function paintQuestDetail(q, el) {
    const paint = (note = null) => {
      const rep = q.report ?? null;
      const judged = rep?.judged ?? [];
      const facts = [`queued ${fullTime(q.at)}`, ranFor(q) ? `ran ${ranFor(q)}` : null, q.finishedAt ? `back ${hm(q.finishedAt)}` : null, q.by ? `by ${q.by}` : null, rep?.splits ? plural(rep.splits, "split") : null, rep?.usage?.turns != null ? `${rep.usage.turns} turns` : null].filter(Boolean);
      const said = rep?.summary ?? q.summary ?? q.why;
      fill(
        el,
        h("div.q-ask", q.task ?? ""),
        h("div.tiny.q-facts", facts.join(" · ")),
        q.tier ? labelled(`the ${many("model")} of size ${sizeLetter(q.size) || "?"}`, tierRow(q.tier)) : null,
        said ? labelled("what came back", h("div.v-md", renderMarkdown(plainText(said)))) : null,
        note ? h("div.tiny.v-empty", note) : null,
        rep?.plan?.length
          ? labelled(
              `the plan · ${plural(rep.plan.length, W.step, many("step"))}`,
              h("ol.q-plan", rep.plan.map((t) => h("li", plainText(typeof t === "string" ? t : (t.task ?? "")), t?.rubric?.length ? h("span.tiny.q-rubric", `rubric: ${t.rubric.join("; ")}`) : null))),
            )
          : null,
        agentLines(q, { max: 40 }) ? labelled(`the ${W.agents}`, agentLines(q, { max: 40 }), rep?.reports?.length ? reportNotes(rep) : null) : null,
        judged.length
          ? labelled(
              `the ${W.review}`,
              h(
                "ul.q-judged",
                judged.map((j) =>
                  h(
                    "li",
                    h("span.q-score", { title: `score ${j.score}` }, h("i", { style: { width: `${Math.round(Math.max(0, Math.min(1, Number(j.score) || 0)) * 100)}%` } })),
                    h("span.tiny", Number.isFinite(Number(j.score)) ? Number(j.score).toFixed(2) : "?"),
                    chip(j.verdict ?? "unjudged", j.verdict === "pass" ? null : j.verdict === "fail" ? "bug" : "warn"),
                    h("span.q-judged-who", `${roleWord(j.tier ?? "promethean")} #${String(j.id ?? "").slice(-4)}${j.by ? ` · by the ${shortBrain(j.by)}` : ""}`),
                    j.note ? h("span.q-judged-note", plainText(j.note)) : null,
                  ),
                ),
              ),
            )
          : null,
        h(
          "div.v-actions",
          h("button.v-link", { type: "button", onclick: () => api?.go?.("loom", `q:${q.id}`) }, `on the ${W.loom}`),
          h("button.v-link", { type: "button", onclick: () => api?.go?.("now", `q:${q.id}`) }, `on ${W.now}`),
          h(
            "button.v-link",
            {
              type: "button",
              onclick: () => {
                E.scope = `q:${q.id}`;
                show("events");
              },
            },
            "its events",
          ),
        ),
      );
    };
    if (q.report || q.status === "queued" || q.status === "running") return paint(q.report ? null : "the report is written when it comes back");
    paint("reading the report…");
    const r = await questStore.load(q.id);
    if (!el.isConnected) return;
    paint(r.ok ? (q.report ? null : "it kept no report") : `the report could not be read: ${r.why}`);
  }

  /** what each agent said beyond its line: its summary, files, what it checked and what it guessed */
  function reportNotes(rep) {
    const said = rep.reports.filter((r) => r.summary || r.files?.length || r.verified?.length || r.inferred?.length || r.open?.length || r.caught?.length);
    if (!said.length) return null;
    const line = (k, list) => (list?.length ? h("div.q-note-line", h("span.tiny", k), h("span", list.map(plainText).join("; "))) : null);
    return h(
      "details.q-notes",
      h("summary.tiny", `what each one said · ${said.length}`),
      said.map((r) => h("div.q-note", h("div.tiny.q-note-who", `${cap(roleWord(r.tier))} #${String(r.id).slice(-4)} · ${shortBrain(r.brain)} · ${r.status ?? ""}`), r.summary ? h("div.v-md", renderMarkdown(plainText(r.summary))) : null, line("files", r.files), line("verified", r.verified), line("inferred", r.inferred), line("open", r.open), line("caught", r.caught))),
    );
  }

  // ================================================================================================
  // events
  // ================================================================================================

  const E = { fams: new Set(), q: "", scope: null };
  const famsEl = h("div.rec-fams", { role: "group", "aria-label": "show only these families" });
  const scopeEl = h("span.rec-scope");
  const search = h("input.v-input.rec-search", { type: "search", "aria-label": "search the events", spellcheck: "false", autocomplete: "off" });
  const evShown = h("span.tiny.rec-shown", { "aria-live": "polite" });
  const evList = h("div.rec-events");
  panes.get("events").append(h("div.rec-main", h("div.rec-filters", famsEl, scopeEl, h("div.rec-find", search, evShown)), h("div.rec-list", { tabindex: "0", "aria-label": "this session's events, newest first" }, evList)));

  search.addEventListener("input", () => {
    E.q = search.value.trim().toLowerCase();
    paintEvents();
  });

  function passes(ev) {
    if (E.fams.size && ![...E.fams].some((f) => prefixesOf(f).some((p) => ev.type.startsWith(p)))) return false;
    if (E.scope) {
      const id = E.scope.slice(2);
      if (!(ev.quest === id || (ev.type.startsWith("quest.") && ev.id === id))) return false;
    }
    if (E.q && !`${ev.type} ${sentence(ev)}`.toLowerCase().includes(E.q)) return false;
    return true;
  }

  function paintEvents() {
    paintMeta();
    fill(
      famsEl,
      h("button.chip.rec-fam.rec-fam-all", { type: "button", "aria-pressed": String(!E.fams.size), onclick: () => (E.fams.clear(), paintEvents()) }, "all"),
      FAMILIES.map((f) =>
        h(
          "button.chip.rec-fam",
          { type: "button", dataset: { fam: f.id }, "aria-pressed": String(E.fams.has(f.id)), onclick: () => (E.fams.has(f.id) ? E.fams.delete(f.id) : E.fams.add(f.id), paintEvents()) },
          familyLabel(f.id),
        ),
      ),
    );
    fill(scopeEl, E.scope ? h("button.chip.rec-fam", { type: "button", "aria-pressed": "true", title: "show every event again", onclick: () => ((E.scope = null), paintEvents()) }, `only ${E.scope.slice(2)} ×`) : null);
    const rows = state.log.filter(passes).slice(-SHOWN_MAX).reverse();
    evShown.textContent = `${rows.length} shown`;
    fill(evList, rows.length ? rows.map((ev) => eventRow(ev, api)) : plainLine(state.log.length ? "no event matches" : "nothing has happened since this page opened"));
  }

  // ---- live -----------------------------------------------------------------------------------

  let frame = 0;
  const soon = () => {
    if (!shown || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (tab === "events") {
        // a row that is open stays open: the list is drawn again only when nothing in it is open
        if (!evList.querySelector(".v-row.open")) paintEvents();
      } else paintQuests();
    });
  };
  on("@quests", soon);
  on("@log", () => tab === "events" && soon());
  on("@stream", paintMeta);
  on("@brand", () => {
    relabel();
    soon();
  });
  relabel();

  return {
    enter(ctx) {
      shown = true;
      context = ctx ?? null;
      if (context?.startsWith("q:")) {
        Q.open = context.slice(2);
        if (!state.quests.has(Q.open)) questStore.load(Q.open);
        tab = "quests";
      }
      questStore.refresh();
      show(tab);
      if (Q.open) qList.querySelector(`.q-row[data-id="${CSS.escape(Q.open)}"]`)?.scrollIntoView?.({ block: "nearest" });
    },
    leave() {
      shown = false;
    },
  };
}
