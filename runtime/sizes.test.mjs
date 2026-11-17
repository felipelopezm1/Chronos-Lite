import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CUT_SIZES, SIZES, autoSize, countAsks, describeSizes, normalSize, parseSizeMarker, resolveTier, tierBrains } from "./sizes.mjs";

const TIERS = {
  s: { titan: null, promethean: "w4", offspring: "o08", maxTasks: 1, tokens: 16000, seconds: 900, note: "no plan" },
  m: { titan: "t9", promethean: "w4", offspring: "o08", maxTasks: 3, tokens: 64000, seconds: 2700, note: "today" },
};

/** a catalogue as brains.list() gives it; `absent` names the brains that are not on disk */
const list = (...absent) =>
  [
    { id: "t9", slot: "talk", role: "talk" },
    { id: "w4", slot: "promethean", role: "promethean" },
    { id: "o08", slot: "offspring", role: "offspring" },
  ].map((b) => ({ ...b, present: !absent.includes(b.id) }));

test("Lite has two sizes, s and m; l is a size it knows only to run as m", () => {
  assert.deepEqual(SIZES, ["s", "m"]);
  assert.deepEqual(CUT_SIZES, { l: "m" });
});

test("normalSize takes any case and the long words, and nothing else", () => {
  assert.equal(normalSize("L"), "l");
  assert.equal(normalSize(" m "), "m");
  assert.equal(normalSize("Small"), "s");
  assert.equal(normalSize("LARGE"), "l");
  assert.equal(normalSize("Auto"), "auto");
  assert.equal(normalSize("xl"), null);
  assert.equal(normalSize(""), null);
  assert.equal(normalSize(3), null);
  assert.equal(normalSize(undefined), null);
});

test("the size marker: [size:x] anywhere in the first line, or size: x at its start, stripped from the task", () => {
  assert.deepEqual(parseSizeMarker("[size:l] Plan the move"), { size: "l", task: "Plan the move" });
  assert.deepEqual(parseSizeMarker("Plan the move [SIZE: S]"), { size: "s", task: "Plan the move" });
  assert.deepEqual(parseSizeMarker("Plan [size=m] the move\nand the rest"), { size: "m", task: "Plan the move\nand the rest" });
  assert.deepEqual(parseSizeMarker("size: m\nPlan the move\nin two steps"), { size: "m", task: "Plan the move\nin two steps" });
  assert.deepEqual(parseSizeMarker("Size: Large - plan the move"), { size: "l", task: "plan the move" });
  assert.deepEqual(parseSizeMarker("size: auto. rename a.txt"), { size: "auto", task: "rename a.txt" });
  assert.deepEqual(parseSizeMarker("Plan the move\n[size:s]"), { size: null, task: "Plan the move\n[size:s]" }, "only the first line names a size");
  assert.deepEqual(parseSizeMarker("size: lovely, keep it"), { size: null, task: "size: lovely, keep it" });
  assert.deepEqual(parseSizeMarker("[size:xl] no such size"), { size: null, task: "[size:xl] no such size" });
  assert.deepEqual(parseSizeMarker("  plain task  "), { size: null, task: "plain task" });
  assert.deepEqual(parseSizeMarker(null), { size: null, task: "" });
  assert.deepEqual(parseSizeMarker("[size:s]"), { size: "s", task: "" }, "a marker alone leaves no task");
});

test("countAsks counts sentences, list lines and what an and or a then joins", () => {
  assert.equal(countAsks("Rename a.txt"), 1);
  assert.equal(countAsks("Count the stars and chart the ocean"), 2);
  assert.equal(countAsks("Read it. Fix it; then test it"), 3);
  assert.equal(countAsks("Answer this: is the port open"), 1, "a colon introduces an ask");
  assert.equal(countAsks("- one\n- two\n- three"), 3);
  assert.equal(countAsks(""), 0);
});

test("autoSize: a plain rule on the task's words, never a model call, and never more than m", () => {
  for (const task of ["Rename a.txt to b.txt", "List the files in runtime", "Tag this note", "Fix the typo in README.md", "Answer yes or no: is the port open"]) {
    const r = autoSize(task);
    assert.equal(r.size, "s", `${task}: ${JSON.stringify(r)}`);
    assert.ok(r.score <= -2);
  }
  for (const task of ["Count the stars and chart the ocean", "Summarise what runtime/server.mjs serves"]) assert.equal(autoSize(task).size, "m", task);
  // what full Chronos would make l is m here, with the score and the reasons kept
  for (const task of ["Plan the migration and compare both designs", Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ")]) {
    const r = autoSize(task);
    assert.equal(r.size, "m", `${task.slice(0, 60)}: ${JSON.stringify(r)}`);
    assert.ok(r.score >= 2);
    assert.ok(r.why.length > 0, "it says why");
  }
  assert.equal(autoSize("List the files and rename the odd ones").size, "m");
  assert.equal(autoSize("").size, "m");
  assert.deepEqual(Object.keys(autoSize("x")).sort(), ["score", "size", "why"]);
});

test("tierBrains: the judge defaults to the Titan, then the Promethean's brain; a named brain takes the Titan's seat", () => {
  assert.deepEqual(tierBrains(TIERS.s), { titan: null, promethean: "w4", offspring: "o08", judge: "w4" });
  assert.deepEqual(tierBrains(TIERS.m), { titan: "t9", promethean: "w4", offspring: "o08", judge: "t9" });
  assert.deepEqual(tierBrains(TIERS.m, "w4"), { titan: "w4", promethean: "w4", offspring: "o08", judge: "w4" });
  assert.deepEqual(tierBrains(null), { titan: null, promethean: null, offspring: null, judge: null });
});

test("resolveTier: the asked size, any case, with its brains and caps", () => {
  const m = resolveTier({ asked: "M", task: "x", tiers: TIERS, list: list() });
  assert.equal(m.ok, true);
  assert.equal(m.size, "m");
  assert.equal(m.asked, "m");
  assert.deepEqual(m.tier, { titan: "t9", promethean: "w4", offspring: "o08", judge: "t9" });
  assert.deepEqual(m.caps, { maxTasks: 3, tokens: 64000, seconds: 2700 });
  assert.deepEqual(m.notes, []);
  assert.equal(m.downgraded, undefined);

  const s = resolveTier({ asked: "s", task: "x", tiers: TIERS, list: list() });
  assert.equal(s.size, "s");
  assert.equal(s.tier.titan, null);
  assert.deepEqual(s.caps, { maxTasks: 1, tokens: 16000, seconds: 900 });

  const small = resolveTier({ task: "Rename a.txt to b.txt", tiers: TIERS, list: list() });
  assert.equal(small.asked, "auto");
  assert.equal(small.size, "s");
  assert.equal(resolveTier({ asked: "auto", task: "Plan the migration and compare both designs", tiers: TIERS, list: list() }).size, "m");
  assert.equal(resolveTier({ asked: "nonsense", task: "Count the stars and chart the ocean", tiers: TIERS, list: list() }).size, "m", "an unknown size is auto");
});

test("resolveTier: a size l (or large) runs as m, and says so", () => {
  for (const asked of ["l", "L", "large"]) {
    const r = resolveTier({ asked, task: "x", tiers: TIERS, list: list() });
    assert.equal(r.ok, true);
    assert.equal(r.size, "m");
    assert.equal(r.asked, "l", "what was asked is kept");
    assert.deepEqual(r.downgraded, { from: "l", to: "m" });
    assert.equal(r.tier.titan, "t9");
    assert.match(r.notes[0], /size l is not in Chronos Lite .*runs as size m/);
  }
  // and when the 9B is not on disk it falls on to s, both notes said
  const no9 = resolveTier({ asked: "l", task: "x", tiers: TIERS, list: list("t9") });
  assert.equal(no9.size, "s");
  assert.equal(no9.notes.length, 2);
  assert.match(no9.notes[1], /size m: its Titan t9 is not on disk; falling back to size s/);
  // with no tiers it is m on the slots, still noted
  const legacy = resolveTier({ asked: "l", task: "x", tiers: null, list: list() });
  assert.equal(legacy.size, "m");
  assert.deepEqual(legacy.downgraded, { from: "l", to: "m" });
});

test("resolveTier: a tier whose lead brain is not on disk falls back to the next smaller one, and says so", () => {
  const no9 = resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list("t9") });
  assert.equal(no9.ok, true);
  assert.equal(no9.size, "s");
  assert.deepEqual(no9.notes, ["size m: its Titan t9 is not on disk; falling back to size s"]);
  const unknown = resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list().filter((b) => b.id !== "t9") });
  assert.match(unknown.notes[0], /t9 is not in the catalogue/);
  const dead = resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list("t9", "w4") });
  assert.equal(dead.ok, false);
  assert.equal(dead.tier, null);
  assert.match(dead.why, /size s: its Promethean brain w4 is not on disk; there is no smaller size to fall back to/);
  assert.equal(resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list(), below: "m" }).size, "s");
  assert.equal(resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list(), below: "s" }).ok, false);
  assert.equal(resolveTier({ asked: "m", task: "x", tiers: TIERS, list: list().map(({ present, ...b }) => b) }).size, "m", "a brain with no present flag counts as there");
});

test("resolveTier with no tiers: every quest is m on the brains in the slots", () => {
  const r = resolveTier({ asked: "s", task: "Rename a.txt", tiers: null, list: list() });
  assert.equal(r.legacy, true);
  assert.equal(r.size, "m");
  assert.deepEqual(r.tier, { titan: "t9", promethean: "w4", offspring: "o08", judge: "t9" });
  assert.deepEqual(r.notes, ["no tiers are configured: size s runs as m"]);
});

test("describeSizes: s and m, each brain's present flag, and where a size that cannot run falls", () => {
  const all = describeSizes({ tiers: TIERS, list: list() });
  assert.deepEqual(Object.keys(all), ["s", "m"]);
  assert.deepEqual(all.m, { ok: true, tier: { titan: "t9", promethean: "w4", offspring: "o08", judge: "t9" }, tokens: 64000, seconds: 2700, maxTasks: 3, note: "today", present: { t9: true, w4: true, o08: true } });
  // a stray l in the tiers is never shown
  assert.deepEqual(Object.keys(describeSizes({ tiers: { ...TIERS, l: { titan: "t27" } }, list: list() })), ["s", "m"]);
  const no9 = describeSizes({ tiers: TIERS, list: list("t9") });
  assert.equal(no9.m.ok, false);
  assert.equal(no9.m.fallsTo, "s");
  assert.equal(no9.m.why, "the Titan t9 is not on disk: a size m quest falls back to size s");
  const dead = describeSizes({ tiers: TIERS, list: list("w4", "t9") });
  assert.equal(dead.s.ok, false);
  assert.equal(dead.s.fallsTo, null);
});

test("the catalogue's own tiers: s has no Titan and leads with the 4B, m is the 9B; no 27B anywhere", () => {
  const cat = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "forge", "brains.json"), "utf8"));
  assert.deepEqual(Object.keys(cat.tiers), ["s", "m"]);
  const brains = cat.brains.map((b) => ({ id: b.id, role: b.role, present: true }));
  const d = describeSizes({ tiers: cat.tiers, list: brains });
  for (const size of SIZES) assert.equal(d[size].ok, true, `${size}: ${d[size].why}`);
  assert.equal(d.s.tier.titan, null);
  assert.equal(d.s.tier.promethean, "qwen3.5-4b");
  assert.equal(d.m.tier.titan, "qwen3.5-9b");
  assert.equal(d.m.tier.offspring, "qwen3.5-0.8b");
  assert.ok(!cat.brains.some((b) => /27b/i.test(b.id) || /27B/.test(b.name)), "the 27B is not in the catalogue");
  assert.ok(cat.brains.every((b) => !b.exclusive), "no brain is alone on the GPU");
});
