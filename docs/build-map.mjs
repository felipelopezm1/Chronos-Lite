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
  { name: "Scaffold", short: "scaffold", date: "2026-11-17", time: "15:00",
    text: "Stage 2. package.json (chronos-lite 0.1.0, Node 22, no dependencies); scripts/check-edition.mjs, first in npm test, holds the caps against the code and the data, keeps cut modules out, and greps every file for home paths, emails, tokens, keys and the owner's login and name; scripts/sync-check.mjs finds the 15 keep files byte for byte the same as Chronos's and says when a reused file changed upstream; CI runs npm test on every push and pull request on Linux and macOS. The licence's copyright line names the Chronos Lite Authors.",
    commits: [] },
  { name: "The core carried", short: "core", date: "2026-11-17", time: "15:30",
    text: "Stage 3. The runtime comes over from Chronos and is cut at four seams: the brains lose Colibri, the server keeps nine routes (/health, /capabilities, /edition, /events with since from an in-memory ring, the quest routes, the UI's files), the bus loses the ledger, and nothing reaches chats or media. Sizes are s and m, an l runs as m with a note; a fall splits at most 2 deep and a quest makes at most 25 brain calls. The brains listen a hundred above Chronos's, the card lock is the full Chronos home's, and the beacon says chronos-lite. docs/runtime-api.md documents every route and event for the slim UI. runtime/e2e.test.mjs drives nine cases over HTTP through the real brains module and runner over a stand-in llama-server; 165 tests in 15 files, 164 pass and the live one is opt-in.",
    commits: [] },
];

export const regions = [
  { id: "project", name: "chronos-lite",
    land: { x: 30, y: 14, w: 1540, h: 730, label: "chronos lite" },
    port: { x: 10, y: 14, w: 500, h: 1780, label: "chronos lite" } },
];

export const nodes = [
  { id: "repo", label: "Chronos-Lite", sub: "repository", kind: "service", region: "project", stage: 0, w: 0.3,
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
  { id: "edition-check", label: "scripts/check-edition.mjs", sub: "the caps, enforced", kind: "script", region: "project", stage: 1, w: 0.3,
    what: "Caps against code and data, no cut modules, no dependencies, nothing personal, the version in step." },
  { id: "sync-check", label: "scripts/sync-check.mjs", sub: "drift from Chronos", kind: "script", region: "project", stage: 1, w: 0.2,
    what: "Keep files compared with a Chronos checkout; reused files watched for upstream change." },
  { id: "ci", label: ".github/workflows/check.yml", sub: "CI", kind: "service", region: "project", stage: 1, w: 0.2,
    what: "npm test on every push and pull request, Linux and macOS, Node 22." },
  { id: "server", label: "runtime/server.mjs", sub: "the service on 7778", kind: "service", region: "project", stage: 2, w: 0.4,
    what: "Nine routes, loopback only, POSTs from this computer only, the heat watchdog, the static UI." },
  { id: "runner", label: "runtime/quests.mjs", sub: "the runner", kind: "service", region: "project", stage: 2, w: 0.4,
    what: "Plan, work, split, judge, trail; sizes s and m, depth 2, 25 turns." },
  { id: "brains", label: "runtime/brains.mjs", sub: "three brains", kind: "service", region: "project", stage: 2, w: 0.3,
    what: "llama-server brains under the governor and the shared card lock." },
  { id: "cardlock", label: "runtime/cardlock.mjs", sub: "one card", kind: "service", region: "project", stage: 2, w: 0.2,
    what: "The same lock file and rules as full Chronos." },
  { id: "bus", label: "runtime/bus.mjs", sub: "the event ring", kind: "store", region: "project", stage: 2, w: 0.2,
    what: "The last 2000 events, replayed with since." },
  { id: "catalogue", label: "forge/brains.json", sub: "the brains", kind: "store", region: "project", stage: 2, w: 0.2,
    what: "0.8B, 4B and 9B, pinned by sha256, tiers s and m." },
  { id: "runtime-api", label: "docs/runtime-api.md", sub: "the contract", kind: "doc", region: "project", stage: 2, w: 0.2,
    what: "Every route and event the UI and a caller may use." },
  { id: "e2e", label: "runtime/e2e.test.mjs", sub: "end to end", kind: "script", region: "project", stage: 2, w: 0.2,
    what: "Nine cases over HTTP on a stand-in llama-server." },
];

export const edges = [
  ["repo", "edition", "lite/", 0],
  ["repo", "brand", "lite/", 0],
  ["repo", "carry", "lite/", 0],
  ["repo", "plan", "docs/", 0],
  ["plan", "decisions", "one per decision", 0],
  ["carry", "edition", "keeps the caps", 0],
  ["edition-check", "edition", "asserts", 1],
  ["sync-check", "carry", "reads", 1],
  ["ci", "edition-check", "npm test", 1],
  ["server", "runner", "the queue", 2],
  ["runner", "brains", "chat", 2],
  ["brains", "cardlock", "one process on the card", 2],
  ["brains", "catalogue", "reads", 2],
  ["server", "bus", "/events", 2],
  ["runner", "bus", "quest and agent events", 2],
  ["runtime-api", "server", "documents", 2],
  ["e2e", "server", "drives over HTTP", 2],
  ["edition-check", "server", "routes and port", 2],
];
