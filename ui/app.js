// The shell of Lite's UI, after Chronos's ui/app.js: one page, no build step. The header carries
// the brand and what the service is doing; the stage holds the backdrop, the oracle dock with the
// face and the view; the bar along the bottom picks the view (now, loom, record, models) and
// carries the built-on mark. The brand comes from GET /edition (ui/brand.js): its name, mark,
// accent, words and avatar; nothing in the page is Chronos's unless the brand is.
//
// Routing lives in the hash: #/<view> and #/<view>/q:<quest id>.
// A view is a module ui/views/<name>.js that exports mount(root, api) and returns
// { enter(context), leave() }; api is { go(view, context), say(text, tone), brand() }, brand() being
// the brand read so far, for a view mounted after the "@brand" notice went out.
//
// window.lite holds the store for the console: lite.inject({ type: "quest.phase", id, phase: "plan" }),
// lite.demo() plays the Loom's scripted quest, lite.face() is the face.

import { h, fill } from "./lib/dom.js";
import { W, setWords, many } from "./lib/words.js";
import { brandOf, applyBrand, monogram } from "./brand.js";
import { api as routes } from "./api.js";
import { state, on, notify, connect, dispatch, inject, refreshAll, refreshHealth, quests, retryStream } from "./store.js";
import { mountBackdrop } from "./backdrop.js";
import { mountDock } from "./dock.js";
import { mountViewBar, VIEW_IDS } from "./viewbar.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const viewHost = $("view");
let brand = brandOf({});

// ---- a one-line notice over the stage -------------------------------------------------------

const toast = $("toast");
let toastTimer = null;
function say(text, tone = "") {
  toast.textContent = text;
  toast.dataset.tone = tone;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), tone === "bug" ? 7000 : 4000);
}

// ---- the dock ---------------------------------------------------------------------------------

let pickedSize = null;
const dock = mountDock($("dock"), { pickedSize: () => pickedSize });
on("@typing", () => dock.typing());
on("@size", (size) => {
  pickedSize = size ?? null;
  dock.paint();
});

/** the views that need the room fold the dock to its avatar; the owner's own fold of a view is kept */
const FOLDS = { now: false, loom: true, record: true, models: true };
const FOLD_KEY = "lite.dock.v1";
const folds = (() => {
  try {
    return { ...JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") };
  } catch {
    return {};
  }
})();
function foldFor(name) {
  const folded = folds[name] ?? FOLDS[name] ?? false;
  dock.setFolded(folded);
  stage.classList.toggle("dock-folded", folded);
}
dock.onFold((folded) => {
  stage.classList.toggle("dock-folded", folded);
  if (!current) return;
  folds[current.name] = folded;
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  } catch {
    /* the fold lasts for this page */
  }
});

// ---- the views and the route --------------------------------------------------------------------

const slots = new Map(); // name -> { root, view, loading }
let current = null;
let turn = 0;

function parse() {
  const m = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash);
  if (!m || !VIEW_IDS.includes(m[1])) return null;
  let context = null;
  try {
    context = m[2] ? decodeURIComponent(m[2]) : null;
  } catch {
    context = null;
  }
  return { view: m[1], context: context && /^q:.+/.test(context) ? context : null };
}
const hashOf = (view, context) => `#/${view}${context ? `/${context}` : ""}`;

function go(view, context = null) {
  if (!VIEW_IDS.includes(view)) return;
  const next = hashOf(view, context);
  if (location.hash === next) route();
  else location.hash = next;
}
/** what every view is handed: go, say, and the brand as read so far (a view mounted later never heard @brand) */
const api = { go, say, brand: () => brand };

async function load(name, slot) {
  try {
    const mod = await import(new URL(`./views/${name}.js`, import.meta.url).href);
    const view = mod.mount(slot.root, api);
    if (!view || typeof view.enter !== "function") throw new Error(`ui/views/${name}.js mounted nothing to enter`);
    slot.view = view;
  } catch (err) {
    console.error(`the ${name} view could not be shown`, err);
    slot.view = null;
    fill(slot.root, h("p.tiny.view-none", "this view could not be shown"));
  }
  slot.loading = null;
}

async function route() {
  const asked = parse() ?? { view: "now", context: null };
  const { view: name, context } = asked;
  if (!parse()) history.replaceState(null, "", hashOf(name, context));
  const my = ++turn;
  const prev = current;
  const same = prev?.name === name;
  if (prev && !same) {
    const old = slots.get(prev.name);
    try {
      old?.view?.leave?.();
    } catch (err) {
      console.error(`the ${prev.name} view threw as it left`, err);
    }
    if (old) old.root.hidden = true;
  }
  current = { name, context };
  viewBar.set(name);
  foldFor(name);
  document.title = `${brand.name} · ${W[name] ?? name}`;
  let slot = slots.get(name);
  if (!slot) {
    slot = { root: h("div.view-root", { dataset: { view: name } }), view: null, loading: null };
    slots.set(name, slot);
    viewHost.append(slot.root);
  }
  slot.root.hidden = false;
  if (!slot.view) {
    slot.loading ??= load(name, slot);
    await slot.loading;
    if (my !== turn) return;
  } else if (same && prev.context === context) return;
  try {
    slot.view?.enter(context);
  } catch (err) {
    console.error(`the ${name} view threw as it was entered`, err);
  }
}
addEventListener("hashchange", route);

// ---- the view bar ---------------------------------------------------------------------------------

const viewLabel = (id) => (id === "models" ? many("model") : W[id] ?? id);
const whereOf = () => `${brand.builtOn}${brand.version ? ` · ${brand.version}` : ""}`;
const viewBar = mountViewBar($("viewbar"), { onPick: (id) => go(id), label: viewLabel, where: whereOf() });

function paintLive() {
  const running = [...state.quests.values()].some((q) => q.status === "running" || q.status === "stopping");
  viewBar.live("now", running || !!state.hold);
  viewBar.live("loom", running);
}
for (const topic of ["@quests", "@hold"]) on(topic, paintLive);

// ---- the header: the brand, the card, the junction, the stream, the colour mode ------------------

const topCard = $("top-card");
const topHeat = $("top-heat");
const topStream = $("top-stream");
const setDot = (el, kind) => (el.querySelector(".dot").className = `dot dot-${kind}`);
const setValue = (el, text) => (el.querySelector("b").textContent = text);

function paintHealth() {
  const hl = state.health;
  const c = hl?.card;
  if (!hl) {
    setDot(topCard, "asleep");
    setValue(topCard, state.healthError ? "not answering" : "—");
    topCard.title = state.healthError ? `the service is not answering: ${state.healthError}` : "";
    topCard.classList.toggle("bug", !!state.healthError);
    return;
  }
  topCard.classList.remove("bug");
  const busyElsewhere = c?.lock && !c.mine && !c.stale;
  setDot(topCard, !c?.lock || c.stale ? "awake" : c.mine ? "on" : "heat");
  setValue(topCard, !c?.lock || c.stale ? "free" : c.mine ? "in use" : "busy elsewhere");
  topCard.classList.toggle("heat", !!busyElsewhere);
  topCard.title = c?.stale ? "a service that has stopped left its claim on the card; the next start clears it" : busyElsewhere ? "another service on this computer holds the card; work waits until it is free" : "the graphics card";
}

function paintHeat() {
  const heat = (state.hardware ?? state.health?.hardware)?.heat;
  const j = heat?.junctionC;
  setValue(topHeat, j == null ? "—" : `${Math.round(j)} C`);
  topHeat.classList.toggle("heat", !!heat?.hot || !!state.hold);
  topHeat.title = j == null ? "the GPU junction: no reading" : `the GPU junction · edge ${heat.edgeC ?? "—"} C · cpu ${heat.cpuC ?? "—"} C${state.hold ? " · held" : ""}`;
}

function paintStream() {
  const s = state.stream.state;
  setDot(topStream, s === "live" ? "awake" : s === "reconnecting" ? "heat" : "asleep");
  const text = s === "live" ? "the event stream is up" : s === "reconnecting" ? "the live feed dropped: reconnecting and catching up" : "connecting to the event stream";
  topStream.querySelector(".sr").textContent = text;
  topStream.title = text;
  const banner = $("banner");
  banner.hidden = s !== "reconnecting" && !state.healthError;
  $("banner-text").textContent = state.healthError ? "The service on this computer is not answering. Retrying every few seconds." : "The live feed dropped. Reconnecting and catching up on what was missed.";
}
$("banner-retry").addEventListener("click", () => {
  refreshHealth();
  retryStream();
});

on("@health", () => (paintHealth(), paintHeat(), paintStream()));
on("@hardware", paintHeat);
on("@hold", paintHeat);
on("@stream", paintStream);

// ---- the colour mode: the system's, light or dark ------------------------------------------------

const MODES = ["system", "light", "dark"];
const modeBtn = $("mode");
function showMode() {
  const m = document.documentElement.dataset.mode ?? "system";
  modeBtn.setAttribute("aria-label", `colour mode: ${m === "system" ? "follows the system" : m}. Change it`);
  modeBtn.title = `colour mode: ${m === "system" ? "follows the system" : m}`;
  modeBtn.querySelector("span").textContent = m === "light" ? "☀" : m === "dark" ? "☾" : "◐";
}
modeBtn.addEventListener("click", () => {
  const now = document.documentElement.dataset.mode ?? "system";
  const next = MODES[(MODES.indexOf(now) + 1) % MODES.length];
  if (next === "system") delete document.documentElement.dataset.mode;
  else document.documentElement.dataset.mode = next;
  try {
    next === "system" ? localStorage.removeItem("ui.mode") : localStorage.setItem("ui.mode", next);
  } catch {
    /* a private window */
  }
  showMode();
  backdrop.redraw();
});
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => backdrop.redraw());

// ---- the brand ---------------------------------------------------------------------------------------

function showBrand() {
  setWords(brand.words, brand.name, brand.vocabulary);
  applyBrand(brand);
  $("brand-name").textContent = brand.name;
  const mark = $("mark");
  fill(mark, brand.logo ? h("img", { src: brand.logo, alt: "" }) : monogram(brand.shortName, brand.name));
  $("brand-version").textContent = brand.version;
  document.documentElement.dataset.vocabulary = brand.vocabulary;
  viewBar.relabel(whereOf());
  dock.setBrand(brand);
  backdrop.redraw();
  notify("brand", brand);
  if (current) document.title = `${brand.name} · ${viewLabel(current.name)}`;
}

async function loadEdition() {
  try {
    brand = brandOf(await routes.edition());
    return true;
  } catch {
    try {
      const hl = await routes.health();
      brand = brandOf({ name: hl.name, version: hl.version });
      return true;
    } catch {
      return false;
    }
  } finally {
    showBrand();
  }
}

// ---- start ------------------------------------------------------------------------------------------------

const backdrop = mountBackdrop($("backdrop"));
showMode();
paintStream();
loadEdition().then((ok) => {
  if (!ok) setTimeout(function again() {
    loadEdition().then((o) => o || setTimeout(again, 5000));
  }, 5000);
  connect();
  refreshAll();
  route();
});
setInterval(refreshHealth, 5000);

/** lite.demo() shows the Loom and plays its scripted quest; no brain needed */
async function demo() {
  go("loom");
  for (let i = 0; i < 40 && !slots.get("loom")?.view; i++) await new Promise((r) => setTimeout(r, 50));
  return slots.get("loom")?.view?.demo?.() ?? false;
}

window.lite = { inject, dispatch, on, notify, state, quests, go, dock, demo, face: () => dock.face(), view: (name) => slots.get(name)?.view ?? null, where: () => ({ ...current }), brand: () => brand };
