#!/usr/bin/env node
/**
 * The test that Chronos Lite is only its own parts, run first by npm test: the caps in lite/edition.json hold in
 * the code and the data (brains, sizes, cards, turns, split depth, tools, port, home, routes), nothing cut is in
 * the tree or imported, there are no npm dependencies, nothing personal is anywhere in the files, the public copy
 * names no AI vendor, and the version is the same everywhere it is written.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.relative(here, fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(path.join(here, p), "utf8"));
const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const edition = read("lite/edition.json");
const brand = read("lite/brand.json");
const carry = read("lite/carry.json");
const catalogue = read("forge/brains.json");
const pkg = read("package.json");

const { SIZES, CUT_SIZES } = await import("../runtime/sizes.mjs");
const { MAX_DEPTH, QUEST_TURNS } = await import("../runtime/quests.mjs");
const { TOOL_NAMES } = await import("../runtime/tools.mjs");
const { DEFAULT_PORT } = await import("../runtime/server.mjs");
const { ROUTES } = await import("../runtime/capabilities.mjs");
const { liteHome } = await import("../runtime/platform.mjs");

// ---- the brains ----
const ids = catalogue.brains.map((b) => b.id);
ok(catalogue.brains.length === edition.brains.max && edition.brains.max === 3, `three brains (forge/brains.json has ${catalogue.brains.length})`);
ok(same([...ids].sort(), [...edition.brains.ids].sort()), `the brains are the edition's own (${ids.join(", ")})`);
ok(!catalogue.alternates?.length, "no alternates in the catalogue");
for (const [role, id] of Object.entries(edition.brains.roles)) ok(ids.includes(id), `the ${role} brain ${id} is in the catalogue`);
for (const b of catalogue.brains) {
  ok(/^[0-9a-f]{64}$/.test(b.sha256 ?? ""), `${b.id} is pinned by sha256`);
  ok(!b.exclusive, `${b.id} is not alone on the GPU (no exclusive brain in Lite)`);
  ok(b.engine == null || b.engine === "llama.cpp", `${b.id} runs on llama-server (no Colibri)`);
  ok(!/27b/i.test(b.id), `${b.id} is not the 27B`);
  ok(Number.isInteger(b.port) && b.port >= 7700 && b.port < 7800 && b.port !== DEFAULT_PORT, `${b.id}'s port ${b.port} is Lite's own (77xx, not the service's)`);
}
ok(new Set(catalogue.brains.map((b) => b.port)).size === catalogue.brains.length, "every brain has its own port");
ok(catalogue.home === edition.service.home, `the catalogue's home is ${edition.service.home}`);
ok(liteHome({ env: {}, platform: "linux", homedir: "/x" }) === edition.service.home.replace("~", "/x"), "runtime/platform.mjs picks the edition's home");

// ---- the sizes, the cards, the quest caps, the tools ----
ok(same(SIZES, edition.sizes) && same(edition.sizes, ["s", "m"]), `sizes s and m in runtime/sizes.mjs (${SIZES.join(", ")})`);
ok(CUT_SIZES?.l === "m", "a size l runs as m");
ok(same(Object.keys(catalogue.tiers), edition.sizes), `the catalogue's tiers are s and m (${Object.keys(catalogue.tiers).join(", ")})`);
for (const [size, t] of Object.entries(catalogue.tiers)) for (const k of ["titan", "promethean", "offspring", "judge"]) if (t[k]) ok(ids.includes(t[k]), `tier ${size}'s ${k} ${t[k]} is in the catalogue`);
ok(edition.cards === 1, "one card");
ok(QUEST_TURNS === edition.quest.maxTurns && QUEST_TURNS === 25, `25 brain turns a quest (runtime/quests.mjs QUEST_TURNS is ${QUEST_TURNS})`);
ok(MAX_DEPTH === edition.quest.splitDepth && MAX_DEPTH === 2, `a fall splits at most 2 deep (runtime/quests.mjs MAX_DEPTH is ${MAX_DEPTH})`);
ok(TOOL_NAMES.length === edition.tools.max && edition.tools.max === 8, `eight tools (runtime/tools.mjs has ${TOOL_NAMES.length})`);
ok(same(TOOL_NAMES, edition.tools.names), "the tools are the edition's own");

// ---- the service ----
ok(DEFAULT_PORT === edition.service.port && DEFAULT_PORT === 7778, `port 7778 (runtime/server.mjs DEFAULT_PORT is ${DEFAULT_PORT})`);
ok(same(ROUTES.map((r) => `${r.method} ${r.path}`), edition.service.routes), "the routes runtime/capabilities.mjs lists are the edition's");
const api = fs.readFileSync(path.join(here, "docs/runtime-api.md"), "utf8");
for (const r of edition.service.routes) ok(api.includes(`## ${r}`) || (r === "GET /" && api.includes("## GET / ")), `docs/runtime-api.md documents ${r}`);

// ---- nothing cut is in the tree or imported ----
const tracked = walk(here);
for (const e of carry.never) ok(!fs.existsSync(path.join(here, e.path)), `${e.path} is cut (lite/carry.json never) and is not in the tree`);
for (const e of [...carry.keep, ...carry.reuse]) ok(fs.existsSync(path.join(here, e.path)), `${e.path} is carried (lite/carry.json) and is in the tree`);
for (const e of carry.own ?? []) ok(fs.existsSync(path.join(here, e.path)), `${e.path} is Lite's own (lite/carry.json own) and is in the tree`);
const CUT_MODULES = /from\s+["']\.\/(bridge|chats|colibri|heph|history|ledger|media|setup|ui|cli)\.mjs["']|import\(\s*["']\.\/(bridge|chats|colibri|heph|history|ledger|media|setup|ui|cli)\.mjs["']/;
for (const f of tracked.filter((f) => f.startsWith("runtime/") && f.endsWith(".mjs"))) ok(!CUT_MODULES.test(fs.readFileSync(path.join(here, f), "utf8")), `${f} imports no cut module`);
ok(!fs.existsSync(path.join(here, "desktop")), "no desktop app");

// ---- no dependencies ----
for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) ok(!pkg[k] || Object.keys(pkg[k]).length === 0, `package.json has no ${k}`);
ok(edition.dependencies === 0, "the edition says zero dependencies");
ok(!fs.existsSync(path.join(here, "node_modules")) || fs.readdirSync(path.join(here, "node_modules")).filter((d) => !d.startsWith(".")).length === 0, "node_modules is empty");

// ---- the white label ----
ok(brand.builtOn === "built on Chronos", "the built-on mark is kept");
ok(brand.setBy === "installer", "the brand is set by the installer");

// ---- nothing personal ships ----
for (const p of ["brain", ".hephaestus", ".chronos", ".chronos-lite", ".env"]) ok(!fs.existsSync(path.join(here, p)), `${p} never ships`);
const PERSONAL = [
  // placeholder homes in tests (/home/me, /Users/me, /home/runner) are not anyone's
  [/\/Users\/(?!(?:me|you|user|someone|runner)\b)[A-Za-z][A-Za-z0-9._-]*/, "an absolute macOS home path"],
  [/\/home\/(?!(?:me|you|user|someone|runner)\b)[a-z_][a-z0-9_-]{1,}/, "an absolute Linux home path"],
  [/[A-Za-z]:\\Users\\[A-Za-z]/, "an absolute Windows home path"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bhf_[A-Za-z0-9]{20,}/, "a Hugging Face token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/letwit/i, "the owner's login"],
  [/felipe/i, "the owner's name"],
];
for (const f of tracked) {
  if (f === SELF || !isText(f)) continue;
  const text = fs.readFileSync(path.join(here, f), "utf8");
  for (const [re, what] of PERSONAL) {
    const m = text.match(re);
    if (m) fails.push(`${f} holds ${what}: ${JSON.stringify(m[0].slice(0, 40))}`);
  }
}

// ---- the public copy names no AI vendor ----
const readme = fs.readFileSync(path.join(here, "README.md"), "utf8");
for (const word of ["Claude", "Anthropic", "OpenAI", "Gemini", "Hugging Face"]) ok(!readme.includes(word), `the README names no vendor (${word})`);

// ---- the version is in step ----
const { stages, nodes, edges } = await import("../docs/build-map.mjs");
ok(/^\d+\.\d+\.\d+$/.test(pkg.version), "package.json has a version");
ok(pkg.version === edition.version, `package.json (${pkg.version}) and lite/edition.json (${edition.version}) agree`);
ok(pkg.name === "chronos-lite", "the package is chronos-lite");
ok(pkg.engines?.node === ">=22", "Node 22 or later");
ok(stages.length >= 1 && stages[0].name === "Founded", "the build map starts at Founded");
for (const n of nodes) ok(Number.isInteger(n.stage) && n.stage >= 0 && n.stage < stages.length, `build map node ${n.id} points at a stage`);
const nodeIds = new Set(nodes.map((n) => n.id));
for (const [a, b, , s] of edges) ok(nodeIds.has(a) && nodeIds.has(b) && s < stages.length, `build map edge ${a} -> ${b} joins nodes that exist`);

if (fails.length) {
  console.error(`edition check: ${fails.length} failed`);
  for (const f of fails) console.error("  FAIL " + f);
  process.exit(1);
}
console.log(`edition check: Chronos Lite is only its own parts (${ids.length} brains, sizes ${SIZES.join(" and ")}, 1 card, ${QUEST_TURNS} turns, depth ${MAX_DEPTH}, ${TOOL_NAMES.length} tools, port ${DEFAULT_PORT}, no dependencies, ${tracked.length} files clean, version ${pkg.version})`);

/** every file in the tree but .git and node_modules, relative and with "/" */
function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function isText(f) {
  return /\.(mjs|js|cjs|json|md|txt|yml|yaml|sh|html|css|svg)$/i.test(f) || ["LICENSE", ".gitignore"].includes(path.basename(f));
}
