// The page: the brand from /edition, health from /health, every task from /events.
// Plain DOM, rendered again from state whenever something changes.

import { api, followEvents } from "./api.js";
import { brandOf, applyBrand, monogram } from "./brand.js";
import { createStore, isActive, roleWord, sizeWord, statusWord, STAGES } from "./quests.js";

const $ = (id) => document.getElementById(id);
const store = createStore();
const state = { brand: brandOf({}), health: null, down: false, stream: "connecting", selected: null, booted: false, minor: new Set(), sending: false };
let words = state.brand.words;

/** h("p.note", {attrs}, ...children): an element; strings become text, never HTML */
function h(tag, attrs = {}, ...kids) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const chip = (s, label) => h("span.chip", { "data-s": s }, label ?? statusWord(s));
const sizeChip = (size) => h("span.chip.chip-size", {}, sizeWord(size, words));
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
function ago(t) {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return clock(t);
}

/* ---------- brand ---------- */

function showBrand() {
  const b = state.brand;
  words = b.words;
  applyBrand(b);
  $("brand-name").textContent = b.name;
  const mark = $("mark");
  mark.replaceChildren();
  if (b.logo) {
    const img = h("img", { src: b.logo, alt: "" });
    img.addEventListener("error", () => (mark.textContent = monogram(b.shortName, b.name)), { once: true });
    mark.append(img);
  } else mark.textContent = monogram(b.shortName, b.name);
  $("built-on").textContent = b.builtOn;
  $("version").textContent = b.version ? `${b.name} ${b.version}` : b.name;
  $("ask-label").textContent = `What should the ${words.agents} do?`;
  $("tasks-title").textContent = words.tasks;
  $("models-title").textContent = words.models;
  for (const el of document.querySelectorAll("[data-word]")) el.textContent = words[el.dataset.word];
  sizeHint();
}

function sizeHint() {
  const v = document.querySelector('input[name="size"]:checked')?.value ?? "auto";
  $("ask-hint").textContent =
    v === "s" ? `One ${words.worker} does it straight away, with no plan.`
    : v === "m" ? `A ${words.planner} splits it into ${words.step}s, ${words.worker}s do them, and the ${words.planner} reviews the results.`
    : `Chooses ${words.quick.toLowerCase()} or ${words.thorough.toLowerCase()} from what the ${words.task} asks.`;
}

/* ---------- header, banner, models ---------- */

function renderHealth() {
  const el = $("health");
  const busy = store.list().some(isActive);
  const s = state.down ? "down" : state.stream === "reconnecting" ? "reconnecting" : !state.health ? "connecting" : busy ? "busy" : "live";
  el.dataset.state = s;
  el.querySelector(".health-text").textContent = { down: "Not answering", reconnecting: "Reconnecting", connecting: "Connecting", busy: "Working", live: "Ready" }[s];

  const card = $("card-state");
  const c = state.health?.card;
  if (!c || state.down) card.hidden = true;
  else {
    card.hidden = false;
    card.textContent = !c.lock ? "Graphics card free" : c.mine ? "Graphics card in use here" : "Graphics card busy elsewhere";
    card.title = c.lock && !c.mine ? "Another service on this computer holds the card; work waits until it is free." : "";
  }

  const banner = $("banner");
  if (state.down) {
    banner.hidden = false;
    banner.dataset.tone = "bad";
    $("banner-text").textContent = `The service on this computer is not answering. Retrying every few seconds; your ${words.tasks.toLowerCase()} are kept.`;
  } else if (state.stream === "reconnecting") {
    banner.hidden = false;
    banner.dataset.tone = "warn";
    $("banner-text").textContent = "The live feed dropped. Reconnecting and catching up on what was missed.";
  } else banner.hidden = true;

  $("send").disabled = state.down || state.sending;
}

const MODEL_STATE = { ready: "loaded", serving: "loaded", loading: "loading", starting: "loading", waiting: "waiting", failed: "failed", stopped: "idle", missing: "missing" };
const MODEL_LABEL = { loaded: "Loaded", loading: "Loading", waiting: "Waiting for card", failed: "Failed", idle: "Idle", missing: "Not installed" };

function renderModels() {
  const ul = $("models");
  const brains = state.health?.brains;
  if (!state.health) {
    ul.replaceChildren(h("li.empty", {}, state.down ? "Unavailable while the service is not answering." : "Reading…"));
    return;
  }
  if (!brains?.length) {
    ul.replaceChildren(h("li.empty", {}, h("strong", {}, `No ${words.model}s installed`), `The installer sets them up; ${words.tasks.toLowerCase()} wait until then.`));
    return;
  }
  const order = { titan: 0, promethean: 1, offspring: 2 };
  ul.replaceChildren(
    ...[...brains].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9)).map((b) => {
      const s = b.present === false ? "missing" : MODEL_STATE[b.status] ?? "idle";
      return h("li.model", {}, h("span", {}, h("span.model-role", {}, cap(roleWord(b.role, words))), h("span.model-id", {}, b.id)), chip(s === "missing" ? "blocked" : s === "idle" ? "queued" : s, MODEL_LABEL[s]));
    }),
  );
}

/* ---------- task list ---------- */

function renderList() {
  const ul = $("tasks");
  ul.setAttribute("aria-busy", String(!state.booted));
  if (!state.booted) {
    ul.replaceChildren(h("li.skeleton"), h("li.skeleton"), h("li.skeleton"));
    return;
  }
  const all = store.list();
  if (!all.length) {
    ul.replaceChildren(
      h("li.empty", {}, h("strong", {}, state.down ? "Nothing to show yet" : `No ${words.tasks.toLowerCase()} yet`),
        state.down ? "Once the service answers, its work appears here." : `Describe one above. It runs on this computer, and you can follow every ${words.step} here.`),
    );
    return;
  }
  ul.replaceChildren(
    ...all.map((q) =>
      h("li", {},
        h("button.task-item", { type: "button", "data-key": `t:${q.id}`, "aria-current": q.id === state.selected ? "true" : null, onclick: () => select(q.id) },
          h("span.task-text", {}, q.task || "(the task text is still loading)"),
          chip(q.status),
          h("span.task-meta", {}, sizeChip(q.size), h("span", {}, ago(q.at))),
        ),
      ),
    ),
  );
}

/* ---------- detail ---------- */

const STAGE_NAME = () => ({ plan: "Plan", work: "Work", review: cap(words.review), done: "Done" });
const STAGE_SUB = (q, s, st) => {
  if (st === "skipped") return `Not needed for ${words.quick.toLowerCase()}`;
  if (s === "plan") return `The ${words.planner} splits the ${words.task}`;
  if (s === "work") return `${cap(words.worker)}s and ${words.helper}s`;
  if (s === "review") return `The ${words.planner} checks each result`;
  return st === "ended" ? statusWord(q.status) : "The answer";
};

function renderDetail() {
  const root = $("detail");
  const q = state.selected ? store.get(state.selected) : null;
  $("layout").dataset.view = q ? "detail" : "list";
  if (!q) {
    root.replaceChildren(h("div.detail-empty", {}, h("div", {}, h("strong", {}, state.booted && store.list().length ? `Choose a ${words.task}` : "Nothing selected"), `Pick a ${words.task} on the left, or send a new one, to follow it live.`)));
    return;
  }
  const active = isActive(q);
  const stopBtn = active ? h("button.btn.btn-stop", { type: "button", "data-key": "stop", disabled: q.status === "stopping" || state.down || null, onclick: () => stop(q.id) }, q.status === "stopping" ? "Stopping…" : "Stop") : null;
  const stages = STAGES.map((s) => {
    const st = q.stages[s] ?? "todo";
    return h("li.stage", { "data-st": st, "aria-current": st === "active" ? "step" : null }, h("b", {}, STAGE_NAME()[s]), STAGE_SUB(q, s, st));
  });
  const agents = [...q.agents.values()];
  const showMinor = state.minor.has(q.id);
  const lines = q.timeline.filter((x) => showMinor || !x.minor);
  const hidden = q.timeline.length - lines.length;

  root.replaceChildren(
    h("button.btn.back", { type: "button", "data-key": "back", onclick: () => select(null) }, `← All ${words.tasks.toLowerCase()}`),
    h("div.d-head", {},
      h("div", {},
        h("h1.d-task", {}, q.task || "(the task text is still loading)"),
        h("div.d-meta", {}, chip(q.status), sizeChip(q.size), h("span", {}, q.at ? `Sent ${clock(q.at)}` : ""), q.doneAt ? h("span", {}, `ended ${clock(q.doneAt)}`) : null),
      ),
      stopBtn,
    ),
    q.downgraded ? h("p.note", {}, `A larger size was asked for; this edition runs it as ${words.thorough.toLowerCase()}.`) : null,
    h("ol.stages", { "aria-label": "Progress" }, stages),
    q.summary || q.why ? h("section.d-section", {}, h("h3", {}, "Result"), h("p.summary", {}, q.summary || q.why)) : null,
    agents.length
      ? h("section.d-section", {}, h("h3", {}, `${cap(words.worker)}s and ${words.helper}s`),
          h("ul.agents", {}, agents.map((a) => h("li.agent", { "data-depth": String(Math.min(a.depth, 2)) },
            h("span.agent-name", {}, `${cap(roleWord(a.tier, words))} ${a.label}`),
            h("span.agent-task", {}, a.summary && a.status !== "working" ? a.summary : a.task),
            chip(a.status)))))
      : null,
    h("section.d-section", {},
      h("h3", {}, "Timeline"),
      lines.length
        ? h("ol.timeline", { "aria-live": "polite" }, lines.map((x, i) =>
            h("li.tl", { "data-k": x.kind, "data-warn": x.warn ? "true" : null, "data-minor": x.minor ? "true" : null, "data-live": active && i === lines.length - 1 ? "true" : null }, h("time", { datetime: new Date(x.t).toISOString() }, clock(x.t)), x.text)))
        : h("p.empty", {}, "Waiting for the first event…"),
      hidden || showMinor ? h("button.btn.btn-quiet.toggle-minor", { type: "button", "data-key": "minor", onclick: () => toggleMinor(q.id) }, showMinor ? "Hide the detailed log" : `Show the detailed log (${hidden} more lines)`) : null,
    ),
  );
}

/* ---------- actions ---------- */

function select(id, { focus = true } = {}) {
  state.selected = id;
  const want = id ? `#/t/${encodeURIComponent(id)}` : "#/";
  if (location.hash !== want) history.replaceState(null, "", want);
  if (id && !store.get(id)?.task) fill(id);
  render();
  if (focus) (id ? $("detail") : $("ask-text")).focus({ preventScroll: false });
}

function toggleMinor(id) {
  state.minor.has(id) ? state.minor.delete(id) : state.minor.add(id);
  keepFocus(renderDetail);
}

async function fill(id) {
  try {
    store.merge(await api.quest(id), words);
    render();
  } catch {
    /* it may have been forgotten by a restart; the stream will say if it comes back */
  }
}

async function stop(id) {
  store.markStopping(id);
  render();
  try {
    await api.stop(id);
  } catch (err) {
    showError(`Could not stop it: ${err.message}`);
  }
}

function showError(text) {
  const el = $("ask-error");
  el.textContent = text;
  el.hidden = !text;
}

async function send(ev) {
  ev.preventDefault();
  const text = $("ask-text").value.trim();
  if (!text) {
    showError(`Describe the ${words.task} first.`);
    $("ask-text").focus();
    return;
  }
  const size = document.querySelector('input[name="size"]:checked')?.value ?? "auto";
  showError("");
  state.sending = true;
  $("send").textContent = "Sending…";
  renderHealth();
  try {
    const r = await api.send(text, size);
    $("ask-text").value = "";
    if (r?.id) {
      if (!store.get(r.id)) store.apply({ type: "quest.queued", id: r.id, task: text, size: r.size, t: Date.now() }, words);
      select(r.id, { focus: false });
    }
  } catch (err) {
    showError(err.status === 0 ? "The service is not answering. Your text is kept; send again when it is back." : `It was not accepted: ${err.message}`);
  } finally {
    state.sending = false;
    $("send").textContent = "Send";
    renderHealth();
  }
}

/* ---------- mode ---------- */

const MODES = ["system", "light", "dark"];
function showMode() {
  const m = document.documentElement.dataset.mode ?? "system";
  const btn = $("mode");
  btn.setAttribute("aria-label", `Colour mode: ${m === "system" ? "follows the system" : m}. Change it`);
  btn.title = `Colour mode: ${m === "system" ? "follows the system" : m}`;
  btn.firstElementChild.textContent = m === "light" ? "☀" : m === "dark" ? "☾" : "◐";
}
function cycleMode() {
  const now = document.documentElement.dataset.mode ?? "system";
  const next = MODES[(MODES.indexOf(now) + 1) % MODES.length];
  if (next === "system") delete document.documentElement.dataset.mode;
  else document.documentElement.dataset.mode = next;
  try {
    next === "system" ? localStorage.removeItem("ui.mode") : localStorage.setItem("ui.mode", next);
  } catch {
    /* private window */
  }
  showMode();
}

/* ---------- the loop ---------- */

/** Re-rendering replaces nodes; keep the keyboard where it was by a data-key on what can take focus. */
function keepFocus(fn) {
  const key = document.activeElement?.dataset?.key;
  fn();
  if (key) document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    keepFocus(() => {
      renderHealth();
      renderModels();
      renderList();
      renderDetail();
    });
  });
}

async function pollHealth() {
  try {
    state.health = await api.health();
    if (state.down) stream.retryNow();
    state.down = false;
  } catch {
    state.down = true;
    state.booted = true;
  }
  render();
}

async function loadEdition() {
  let e = null;
  try {
    e = await api.edition();
  } catch {
    try {
      const hl = await api.health();
      e = { name: hl.name, version: hl.version };
    } catch {
      /* the defaults hold until the service answers */
    }
  }
  if (e) {
    state.brand = brandOf(e);
    showBrand();
    render();
  }
  return !!e;
}

const BRAIN_STATUS = { "brain.loading": "loading", "brain.ready": "ready", "brain.stopped": "stopped", "brain.failed": "failed", "brain.waiting": "waiting" };
function onEvent(ev) {
  if (BRAIN_STATUS[ev.type] && state.health?.brains) {
    const b = state.health.brains.find((x) => x.id === ev.id);
    if (b) b.status = BRAIN_STATUS[ev.type];
  }
  const id = store.apply(ev, words);
  if (id && ev.type === "quest.done" && state.selected === id) fill(id);
  render();
}

let stream;
function boot() {
  showBrand();
  showMode();
  render();
  $("mode").addEventListener("click", cycleMode);
  $("ask").addEventListener("submit", send);
  $("ask-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("ask").requestSubmit();
  });
  $("ask-text").addEventListener("input", () => showError(""));
  for (const r of document.querySelectorAll('input[name="size"]')) r.addEventListener("change", sizeHint);
  $("banner-retry").addEventListener("click", () => {
    pollHealth();
    stream.retryNow();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected && !e.target.closest?.("textarea")) select(null);
  });
  window.addEventListener("hashchange", fromHash);

  stream = followEvents({
    onEvent,
    onState: (s) => {
      state.stream = s;
      if (s === "live") {
        state.booted = true;
        fromHash();
      }
      render();
    },
  });
  loadEdition().then((ok) => {
    if (!ok) setTimeout(function again() { loadEdition().then((o) => o || setTimeout(again, 5000)); }, 5000);
  });
  pollHealth();
  setInterval(pollHealth, 5000);
  setInterval(() => !document.hidden && renderList(), 15000);
  // the stream answers with its replay at once; a quiet one still counts as booted after a moment
  setTimeout(() => {
    state.booted = true;
    fromHash();
    render();
  }, 1500);
}

function fromHash() {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : null;
  if (id !== state.selected) select(id, { focus: false });
}

const cap = (s) => String(s ?? "").replace(/^./, (c) => c.toUpperCase());

boot();
