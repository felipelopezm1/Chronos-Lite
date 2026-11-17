/**
 * The build map of Chronos Lite: how it was built, stage by stage. Hephaestus draws it in the armory.
 * Append a stage for every change that adds or reshapes a part (never reorder: nodes and edges
 * point at stages by index), add its parts to `nodes` and its threads to `edges`.
 */
export const sheets = { land: { w: 1600, h: 760 }, port: { w: 520, h: 1810 } };

export const stages = [
  { name: "Founded", short: "founded", date: "2026-11-17", time: "12:00",
    text: "Stage 1. Chronos Lite is carved out of Chronos by a list, the way Hephaestus Lite was carved out of Hephaestus: its own public repository under Apache 2.0, lite/edition.json with the caps (3 brains, sizes s and m, 1 card, 25 turns a quest, split depth 2, 8 tools, port 7778) and what is cut, lite/brand.json for the white label, lite/carry.json sorting all 303 files of Chronos's runtime, forge, scripts, ui, desktop and docs into keep, reuse, rewrite and never, the plan and ten decision records, one per owner decision.",
    commits: [] },
];

export const regions = [
  { id: "project", name: "chronos-lite",
    land: { x: 30, y: 14, w: 1540, h: 730, label: "chronos lite" },
    port: { x: 10, y: 14, w: 500, h: 1780, label: "chronos lite" } },
];

export const nodes = [
  { id: "repo", label: "felipelopezm1/Chronos-Lite", sub: "repository", kind: "service", region: "project", stage: 0, w: 0.3,
    what: "A smaller, white-label Chronos: a local-models harness with three brains, two sizes and one card, hired over HTTP." },
  { id: "edition", label: "lite/edition.json", sub: "the caps", kind: "doc", region: "project", stage: 0, w: 0.3,
    what: "What Lite is, as numbers the check holds: brains, sizes, cards, turns, depth, tools, port, and the cut list." },
  { id: "brand", label: "lite/brand.json", sub: "white label", kind: "doc", region: "project", stage: 0, w: 0.2,
    what: "The name, accent and logo an installer sets, with the built-on-Chronos mark." },
  { id: "carry", label: "lite/carry.json", sub: "the carry list", kind: "doc", region: "project", stage: 0, w: 0.3,
    what: "Every Chronos file sorted keep, reuse, rewrite or never, with a line on why." },
  { id: "plan", label: "docs/plan.md", sub: "the plan", kind: "doc", region: "project", stage: 0, w: 0.3,
    what: "What Lite is, what is cut, how it lives beside full Chronos, and the six stages." },
  { id: "decisions", label: "docs/decisions", sub: "ten records", kind: "doc", region: "project", stage: 0, w: 0.2,
    what: "One record per owner decision: own repo, licence, sizes, brains, wisp only, UI later, no desktop, port, card lock, home." },
];

export const edges = [
  ["repo", "edition", "lite/", 0],
  ["repo", "brand", "lite/", 0],
  ["repo", "carry", "lite/", 0],
  ["repo", "plan", "docs/", 0],
  ["plan", "decisions", "one per decision", 0],
  ["carry", "edition", "keeps the caps", 0],
];
