// The view bar along the bottom (Hephaestus's ViewBar): now · loom · record ·
// brains as flat cells divided by hairlines, each named in the brand's words. The
// active cell carries a 1px accent hairline on its top edge that slides to the
// next one; a cell shows a live dot while something happens in its view.
// Alt+Shift+1..4 picks a view. The right end carries the built-on mark.

import { h, fill, glyph } from "./lib/dom.js";
import { W, the, many } from "./lib/words.js";

/** The views, in the order of the bar. Each is a module ui/views/<id>.js; its name is the brand's word. */
export const VIEWS = [
  { id: "now", title: () => `what is going on, and a new ${W.task}`, d: "M1 6.5h2.5L5 2.5l2 7L8.5 6.5H11" },
  { id: "loom", title: () => `the ${W.agents} of a ${W.task} as stones off ${the("planner")}`, d: "M2 8l1.5-4.5 4-2 3 3.5L9 10l-5 .5Z" },
  { id: "record", title: () => `what went on: the ${many("task")} and this session's events`, d: ["M1.5 2.5h9", "M1.5 6h9", "M1.5 9.5h6"] },
  { id: "models", title: () => `the ${many("model")}, the sizes and the hardware`, d: ["M3 3h6v6H3Z", "M5 1.5V3M7 1.5V3M5 9v1.5M7 9v1.5M1.5 5H3M1.5 7H3M9 5h1.5M9 7h1.5"] },
];
export const VIEW_IDS = VIEWS.map((v) => v.id);

/**
 * mountViewBar(nav, { onPick(id), label(id), where }) -> { set(id), live(id, on), show(id, on), relabel() }
 * `where` is the small label at the right end (the built-on mark and the version).
 */
export function mountViewBar(nav, { onPick, label = (id) => id, where = "" }) {
  const line = h("span.vb-line", { "aria-hidden": "true" });
  const cells = new Map();
  const dots = new Map();
  let active = null;

  nav.setAttribute("role", "tablist");
  fill(
    nav,
    VIEWS.map((v, i) => {
      const liveDot = h("span.vb-live", { hidden: true, "aria-hidden": "true" });
      const cell = h(
        "button.vb-cell",
        { type: "button", role: "tab", "aria-selected": "false", tabindex: "-1", hidden: !!v.hidden, dataset: { view: v.id }, title: `${v.title()} (alt shift ${i + 1})`, onclick: () => onPick(v.id) },
        glyph(v.d),
        h("span.vb-name", label(v.id)),
        liveDot,
      );
      cell.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        // the next cell that shows, in the arrow's direction
        const step = e.key === "ArrowRight" ? 1 : VIEWS.length - 1;
        let at = (i + step) % VIEWS.length;
        while (at !== i && cells.get(VIEWS[at].id)?.hidden) at = (at + step) % VIEWS.length;
        const next = VIEWS[at].id;
        onPick(next);
        cells.get(next)?.focus();
      });
      cells.set(v.id, cell);
      dots.set(v.id, liveDot);
      return cell;
    }),
    h("span.vb-rest"),
    h("span.tiny.vb-where", where),
    line,
  );

  function slide() {
    const cell = cells.get(active);
    if (!cell) return;
    line.style.width = `${cell.offsetWidth}px`;
    line.style.transform = `translateX(${cell.offsetLeft}px)`;
  }
  addEventListener("resize", slide);

  addEventListener("keydown", (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const n = /^Digit([1-4])$/.exec(e.code)?.[1];
    if (!n) return;
    const id = VIEWS[Number(n) - 1]?.id;
    if (!id || cells.get(id)?.hidden) return;
    e.preventDefault();
    onPick(id);
  });

  return {
    set(id) {
      active = id;
      for (const [k, cell] of cells) {
        const on = k === id;
        cell.setAttribute("aria-selected", on ? "true" : "false");
        cell.tabIndex = on ? 0 : -1;
      }
      slide();
      const cell = cells.get(id);
      if (cell && nav.scrollWidth > nav.clientWidth) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    /** something is happening in a view (or stopped happening) */
    live(id, on) {
      const d = dots.get(id);
      if (!d || d.hidden === !on) return;
      d.hidden = !on;
      cells.get(id).classList.toggle("live", !!on);
      const cell = cells.get(id);
      const base = cell.title.replace(/ · something is happening$/, "");
      cell.title = on ? `${base} · something is happening` : base;
      slide();
    },
    /** a cell that is there only when its view has something to show (setup) */
    show(id, on) {
      const cell = cells.get(id);
      if (!cell || cell.hidden === !on) return;
      cell.hidden = !on;
      nav.classList.toggle(`has-${id}`, !!on);
      slide();
    },
    slide,
    /** the brand's words changed: every cell says its view again */
    relabel(where) {
      for (const v of VIEWS) {
        const cell = cells.get(v.id);
        cell.querySelector(".vb-name").textContent = label(v.id);
        cell.title = `${v.title()} (alt shift ${VIEWS.indexOf(v) + 1})`;
      }
      if (where !== undefined) nav.querySelector(".vb-where").textContent = where;
      slide();
    },
  };
}
