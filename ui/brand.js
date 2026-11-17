// The white label: what /edition says becomes the page's name, mark, accent, words and avatar.
// Nothing here reaches the network. The defaults are the essence of Chronos: its blue, its
// words (quest, titan, promethean, offspring, brain, loom) and its face; a company that rebrands
// Lite sets its own in lite/brand.json and the service hands them over in GET /edition.

/** Chronos's own blue: the accent when a brand names none. */
export const DEFAULT_ACCENT = "#2563eb";

/**
 * The words the page shows, in one place. `chronos` is the essence (the default brand);
 * `plain` is the neutral set a company starts from. A brand picks one with `vocabulary` (the shipped
 * lite/brand.json says "chronos"; left out, it is `plain`, so a company's brand never shows the
 * runtime's inner names by accident) and
 * may rename any word with `words`. Keys are fixed; values are lowercase as they read in a
 * sentence (the chrome sets them in capitals by itself).
 */
export const VOCABULARIES = {
  chronos: {
    task: "quest",
    tasks: "quests",
    step: "task",
    steps: "tasks",
    planner: "titan",
    worker: "promethean",
    workers: "prometheans",
    helper: "offspring",
    helpers: "offspring",
    review: "judge",
    model: "brain",
    models: "brains",
    agents: "agents",
    auto: "auto",
    quick: "s",
    thorough: "m",
    now: "now",
    loom: "loom",
    record: "record",
    oracle: "the oracle",
  },
  plain: {
    task: "task",
    tasks: "tasks",
    step: "step",
    steps: "steps",
    planner: "planner",
    worker: "worker",
    workers: "workers",
    helper: "helper",
    helpers: "helpers",
    review: "review",
    model: "model",
    models: "models",
    agents: "agents",
    auto: "auto",
    quick: "quick",
    thorough: "thorough",
    now: "now",
    loom: "threads",
    record: "history",
    oracle: "status",
  },
};
export const WORD_KEYS = Object.keys(VOCABULARIES.chronos);
/** the words of the default brand */
export const DEFAULT_WORDS = VOCABULARIES.chronos;

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** A hex colour as #rrggbb; any other CSS colour ("teal", "rgb(29 78 216)") is read through the browser. */
export function validHex(v) {
  if (typeof v !== "string") return null;
  if (!HEX.test(v.trim())) return cssColour(v.trim());
  let h = v.trim().replace("#", "").toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h}`;
}

function cssColour(v) {
  if (!v || typeof document === "undefined" || !globalThis.CSS?.supports?.("color", v)) return null;
  const el = document.createElement("span");
  el.style.color = v;
  document.documentElement.append(el);
  const m = getComputedStyle(el).color.match(/(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/);
  el.remove();
  return m ? toHex(m.slice(1, 4).map(Number)) : null;
}

export const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
export const mix = (a, b, t) => toHex(rgbOf(a).map((v, i) => v + (rgbOf(b)[i] - v) * t));
const triple = (hex) => rgbOf(hex).join(" ");

function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Move a colour towards `to` in small steps until test passes (or it reaches `to`). */
function nudge(hex, to, test) {
  for (let t = 0; t <= 1.001; t += 0.02) {
    const c = mix(hex, to, Math.min(t, 1));
    if (test(c)) return c;
  }
  return to;
}

/** A colour's hue (0..360), saturation and lightness (0..1). */
export function hsl(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** The grounds of the two modes: the near-black of Chronos, and a cool paper for light. */
export const GROUNDS = { dark: "#05070b", light: "#f3f5f9" };
const INKS = { dark: "#e6edf7", light: "#0b1322" };

/**
 * The accent and everything tinted by it, for one mode, as the CSS custom properties the
 * stylesheet reads. In dark the accent is Chronos's pair: the fill and a brighter one for lines
 * and text on the black; in light the "hot" one moves darker until it reads on paper. The
 * neutrals (hairlines, muted text, panel borders) carry the accent's hue, as Chronos's carry
 * its blue, so a green brand gets green-grey hairlines.
 */
export function accentTokens(hex, mode) {
  const ground = GROUNDS[mode];
  const ink = INKS[mode];
  if (mode === "dark") {
    const hot = nudge(hex, "#ffffff", (c) => contrast(c, ground) >= 7);
    const fill = nudge(hex, "#ffffff", (c) => contrast(c, ground) >= 3.2);
    return {
      "--red": fill,
      "--red-hot": hot,
      "--red-rgb": triple(fill),
      "--hot-rgb": triple(hot),
      "--ice": mix(hex, "#ffffff", 0.86),
      "--ice-rgb": triple(mix(hex, "#ffffff", 0.86)),
      "--soft": mix(hex, "#ffffff", 0.55),
      "--soft-rgb": triple(mix(hex, "#ffffff", 0.55)),
      "--rock": mix(hex, ground, 0.6),
      "--rock-light": mix(hex, ground, 0.38),
      "--rock-rgb": triple(mix(hex, ground, 0.6)),
      "--head-bg": mix(hex, ground, 0.94),
      "--fg-rgb": triple(ink),
    };
  }
  const hot = nudge(hex, "#000000", (c) => contrast(c, "#ffffff") >= 4.8 && contrast(c, ground) >= 4.5);
  const fill = nudge(hex, "#000000", (c) => contrast(c, "#ffffff") >= 3.2);
  const deep = mix(hot, ink, 0.45);
  return {
    "--red": fill,
    "--red-hot": hot,
    "--red-rgb": triple(fill),
    "--hot-rgb": triple(hot),
    "--ice": deep,
    "--ice-rgb": triple(mix(hex, ink, 0.82)),
    "--soft": mix(hot, ink, 0.2),
    "--soft-rgb": triple(mix(hex, ink, 0.55)),
    "--rock": mix(hex, "#ffffff", 0.7),
    "--rock-light": mix(hex, "#ffffff", 0.45),
    "--rock-rgb": triple(mix(hex, "#ffffff", 0.7)),
    "--head-bg": mix(hex, "#ffffff", 0.95),
    "--fg-rgb": triple(ink),
  };
}

/** The monogram: the initials of a two-word short name (Acme Corp: AC), else its first letter (Acme: A). */
export function monogram(shortName, name) {
  const s = String(shortName || name || "A").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return s.slice(0, 1).toUpperCase();
}

/** A path or address the page may load without leaving this computer. */
const localUrl = (v) => typeof v === "string" && /^(data:image\/|\/(?!\/)|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/])/.test(v.trim());

/** The face's own blue, the hue a tint turns from. */
export const FACE_BLUE = "#5f8fda";

/**
 * The avatar in the dock. kind "face": Chronos's face (ui/face/face.js) from its own frames, or a
 * brand's frames (a folder the service serves with the same eight file names); `tint` turns her
 * blues to another hue ("accent" for the brand's accent, or a colour), her greys stay grey.
 * kind "monogram": the plain mark (the logo, else the monogram), with the state on a ring.
 */
export function avatarOf(a, accent = DEFAULT_ACCENT) {
  const x = a && typeof a === "object" ? a : {};
  const kind = x.kind === "monogram" ? "monogram" : "face";
  const frames = localUrl(x.frames) && !x.frames.startsWith("data:") ? `${x.frames.trim().replace(/\/*$/, "")}/` : null;
  const tint = x.tint === "accent" ? accent : validHex(x.tint);
  return { kind, frames, tint: kind === "face" ? tint : null };
}

/**
 * The CSS filter that turns the face's blues to a tint: a hue rotation (greys stay grey under
 * it, so the stone stays stone) and a saturation step towards the tint's own. "" for no tint.
 */
export function tintFilter(tint) {
  if (!tint) return "";
  const to = hsl(tint);
  const from = hsl(FACE_BLUE);
  if (to.s < 0.08) return "saturate(0.12)";
  let turn = Math.round(to.h - from.h);
  if (turn > 180) turn -= 360;
  if (turn < -180) turn += 360;
  const sat = Math.max(0.45, Math.min(1.6, to.s / from.s));
  return `hue-rotate(${turn}deg) saturate(${sat.toFixed(2)})`;
}

const clean = (v, n = 40) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** Turn /edition into the brand the page shows, with every field defaulted. */
export function brandOf(edition = {}) {
  const e = edition && typeof edition === "object" ? edition : {};
  const name = clean(e.name, 60) ?? "Chronos Lite";
  // a brand that names no vocabulary gets the plain words: only the shipped brand says "chronos" outright
  const vocabulary = VOCABULARIES[e.vocabulary] ? e.vocabulary : "plain";
  const words = { ...VOCABULARIES[vocabulary] };
  if (e.words && typeof e.words === "object") {
    for (const [k, v] of Object.entries(e.words)) if (k in words && clean(v)) words[k] = clean(v);
  }
  const shortName = clean(e.shortName, 40) ?? name;
  const accent = validHex(e.accent) ?? DEFAULT_ACCENT;
  return {
    name,
    shortName,
    accent,
    logo: localUrl(e.logo) ? e.logo.trim() : null,
    builtOn: clean(e.builtOn, 80) ?? "built on Chronos",
    version: typeof e.version === "string" ? e.version : "",
    vocabulary,
    words,
    avatar: avatarOf(e.avatar, accent),
  };
}

/** Write the accent for both modes into one style element; the CSS chooses which applies. */
export function applyBrand(brand, doc = document) {
  const block = (t) => Object.entries(t).map(([k, v]) => `${k}:${v};`).join("");
  const dark = block(accentTokens(brand.accent, "dark"));
  const light = block(accentTokens(brand.accent, "light"));
  let el = doc.getElementById("brand-accent");
  if (!el) {
    el = doc.createElement("style");
    el.id = "brand-accent";
    doc.head.append(el);
  }
  el.textContent = [
    `:root{${dark}}`,
    `@media (prefers-color-scheme: light){:root:not([data-mode="dark"]){${light}}}`,
    `:root[data-mode="light"]{${light}}`,
    `:root{--face-tint:${tintFilter(brand.avatar.tint) || "none"};--stage-hot:${accentTokens(brand.accent, "dark")["--red-hot"]};}`,
  ].join("\n");
  doc.title = brand.name;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", GROUNDS.dark);
}
