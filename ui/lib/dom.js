// Small DOM helpers: the UI is plain modules, so every view builds its nodes
// with h() and never writes HTML from data (text always goes in as text).

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "g", "circle", "rect", "line", "polyline", "polygon", "text", "tspan", "defs", "mask", "radialGradient", "linearGradient", "stop", "title", "ellipse", "use"]);

/**
 * h("button.chip.on", { type: "button", onclick, "aria-pressed": true }, "send")
 * A tag with .classes and #id; props that start with "on" are listeners, a
 * `dataset` object sets data-*, `style` may be an object, false and null
 * attributes are left out; children may be nodes, strings, numbers, arrays or
 * null.
 */
export function h(spec, props, ...children) {
  if (props !== undefined && (props === null || typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const [tagAndId, ...classes] = String(spec).split(".");
  const [tag, id] = tagAndId.split("#");
  const name = tag || "div";
  const el = SVG_TAGS.has(name) ? document.createElementNS(SVG_NS, name) : document.createElement(name);
  if (id) el.id = id;
  if (classes.length) el.setAttribute("class", classes.join(" "));
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.setAttribute("class", [el.getAttribute("class"), v].filter(Boolean).join(" "));
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "open") el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  add(el, children);
  return el;
}

/** Append children: nodes, text, arrays; null, undefined and false are skipped. */
export function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace everything inside el. */
export function fill(el, ...children) {
  el.replaceChildren();
  return add(el, ...children);
}

/** A hairline glyph: 12 by 12, stroke 1, square caps (the view bar's and the buttons'). */
export function glyph(d, { size = 11, fill: f = "none" } = {}) {
  const paths = Array.isArray(d) ? d : [d];
  return h("svg.glyph", { viewBox: "0 0 12 12", width: size, height: size, "aria-hidden": "true" }, ...paths.map((p) => h("path", { d: p, fill: f, stroke: "currentColor", "stroke-width": "1", "stroke-linecap": "square" })));
}

/** A 6px status dot: on (accent, pulsing), awake (white), asleep (hollow), heat. */
export function dot(kind = "awake", title) {
  return h(`span.dot.dot-${kind}`, { "aria-hidden": title ? null : "true", title, role: title ? "img" : null, "aria-label": title });
}

/** A chip: small, bordered, uppercase. tone: hot (accent), heat, warn, bug, mute. */
export function chip(text, tone, title) {
  return h("span.chip", { dataset: tone ? { tone } : null, title }, text);
}

/** Close a popover on a press outside it or on Escape; returns the undo. */
export function dismissable(el, close, { anchor } = {}) {
  const away = (e) => {
    if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
  };
  const esc = (e) => {
    if (e.key === "Escape") {
      close();
      anchor?.focus?.();
    }
  };
  document.addEventListener("mousedown", away);
  document.addEventListener("keydown", esc);
  return () => {
    document.removeEventListener("mousedown", away);
    document.removeEventListener("keydown", esc);
  };
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
