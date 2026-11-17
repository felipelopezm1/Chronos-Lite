// The white label: what /edition says becomes the page's name, mark, accent and words.
// A valid hex accent takes over the accent in light and in dark; it is nudged lighter or
// darker only as far as it must be to keep WCAG AA contrast on that mode's surfaces.

export const DEFAULT_ACCENT = "#0f766e";

/** The visible words. /edition may carry a `words` map that overrides any of them. */
export const DEFAULT_WORDS = {
  task: "task",
  tasks: "Tasks",
  step: "step",
  planner: "planner",
  worker: "worker",
  helper: "helper",
  review: "review",
  model: "model",
  models: "Models",
  auto: "Auto",
  quick: "Quick",
  thorough: "Thorough",
  agents: "agents",
};

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** A hex accent as #rrggbb; any other CSS colour ("rebeccapurple", "rgb(29 78 216)") is read through the browser. */
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

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
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
  for (let t = 0; t <= 1.001; t += 0.04) {
    const c = mix(hex, to, Math.min(t, 1));
    if (test(c)) return c;
  }
  return to;
}

const MODES = {
  light: { surface: "#ffffff", bg: "#f6f7f8", towards: "#000000" },
  dark: { surface: "#1b1d20", bg: "#121315", towards: "#ffffff" },
};

/** The accent tokens for one mode: fill (buttons), ink (text on the fill), text (accent as text), soft (tint). */
export function accentTokens(hex, mode) {
  const m = MODES[mode];
  const inkOf = (c) => (contrast(c, "#ffffff") >= contrast(c, "#111111") ? "#ffffff" : "#111111");
  const fill = nudge(hex, m.towards, (c) => contrast(c, inkOf(c)) >= 4.5 && contrast(c, m.surface) >= 3);
  const text = nudge(hex, m.towards, (c) => contrast(c, m.surface) >= 4.5 && contrast(c, m.bg) >= 4.5);
  const [r, g, b] = rgb(fill);
  return { fill, ink: inkOf(fill), text, soft: `rgb(${r} ${g} ${b} / ${mode === "dark" ? 0.18 : 0.1})`, ring: `rgb(${r} ${g} ${b} / 0.45)` };
}

function block(t) {
  return `--accent:${t.fill};--accent-ink:${t.ink};--accent-text:${t.text};--accent-soft:${t.soft};--focus:${t.ring};`;
}

/** The monogram: the initials of a two-word short name (Acme Corp: AC), else its first letter (Acme: A). */
export function monogram(shortName, name) {
  const s = String(shortName || name || "A").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return s.slice(0, 1).toUpperCase();
}

/** Turn /edition into the brand the page shows, with every field defaulted. */
export function brandOf(edition = {}) {
  const e = edition && typeof edition === "object" ? edition : {};
  const words = { ...DEFAULT_WORDS };
  if (e.words && typeof e.words === "object") {
    for (const [k, v] of Object.entries(e.words)) if (k in words && typeof v === "string" && v.trim()) words[k] = v.trim().slice(0, 40);
  }
  const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Agents";
  const shortName = typeof e.shortName === "string" && e.shortName.trim() ? e.shortName.trim() : name;
  const logo = typeof e.logo === "string" && /^(data:image\/|\/|https?:\/\/(localhost|127\.0\.0\.1)[:/])/.test(e.logo) ? e.logo : null;
  return {
    name,
    shortName,
    accent: validHex(e.accent) ?? DEFAULT_ACCENT,
    logo,
    builtOn: typeof e.builtOn === "string" && e.builtOn.trim() ? e.builtOn.trim() : "built on Chronos",
    version: typeof e.version === "string" ? e.version : "",
    words,
  };
}

/** Write the accent for both modes into one style element; the CSS chooses which applies. */
export function applyBrand(brand, doc = document) {
  const light = accentTokens(brand.accent, "light");
  const dark = accentTokens(brand.accent, "dark");
  let el = doc.getElementById("brand-accent");
  if (!el) {
    el = doc.createElement("style");
    el.id = "brand-accent";
    doc.head.append(el);
  }
  el.textContent = [
    `:root{${block(light)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-mode="light"]){${block(dark)}}}`,
    `:root[data-mode="dark"]{${block(dark)}}`,
  ].join("\n");
  doc.title = brand.name;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", light.fill);
}
