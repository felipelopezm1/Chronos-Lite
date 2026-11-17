import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bus } from "./bus.mjs";
import { partialState, resetIds, STATE_MAX_CHARS } from "./promethean.mjs";
import { createServer } from "./server.mjs";
import { verifyChain, readChain } from "./trail.mjs";
import { DEFAULT_RUBRIC, MAX_DEPTH, PACE_C, QUEST_TURNS, advisorySummary, createRunner, filesNamed, sharesAFile, fallbackPlan, generatedTokens, parseJudgement, parseJudgements, parsePlan, questCaps, questStatus, trailBody, workerCap } from "./quests.mjs";

const TALK = "qwen3.5-9b";
const WORKER = "qwen3.5-4b";
const OFFSPRING = "qwen3.5-0.8b";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a cold box with room for three workers; the worker brain has two slots */
const cold = () => ({
  vram: { totalMiB: 12288, usedMiB: 1000, freeMiB: 11288, card: "test" },
  ram: { totalMiB: 30000, availableMiB: 20000 },
  cpu: { threads: 16, load1: 0.5 },
  heat: { junctionC: 60, edgeC: 50, critC: 100, cpuC: 70, hot: false },
  at: Date.now(),
});
const hot = () => ({ ...cold(), heat: { junctionC: 95, edgeC: 80, critC: 100, cpuC: 85, hot: true } });

/** a hardware sense that gives these readings in turn; the last one repeats */
function fakeHardware(readings) {
  const left = [...readings];
  return { readHardware: () => (left.length > 1 ? left.shift() : left[0]), fits: () => ({ ok: true, why: "" }), watchHardware: () => () => {} };
}

const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
const say = (text) => ({ content: text, toolCalls: [], usage, tokensPerSecond: 50 });
let callN = 0;
const callTool = (name, args) => ({ content: "", toolCalls: [{ id: `c${++callN}`, name, arguments: args }], usage, tokensPerSecond: 50 });
const taskOf = (user) => user.match(/Task:\n([^\n]*)/)?.[1] ?? user;

/**
 * Stand-in brains: three in the catalogue, one per slot. chat() answers from
 * the script and records every call with how many were in flight per brain.
 */
function fakeBrains(script) {
  const status = { [TALK]: "idle", [WORKER]: "idle", [OFFSPRING]: "idle" };
  const calls = [];
  const busy = {};
  const peak = {};
  return {
    calls,
    peak,
    list: () => [
      { id: TALK, role: "talk", slot: "talk", status: status[TALK], parallel: 2 },
      { id: WORKER, role: "promethean", slot: "promethean", status: status[WORKER], parallel: 2 },
      { id: OFFSPRING, role: "offspring", slot: "offspring", status: status[OFFSPRING], parallel: 4 },
    ],
    async start(id) {
      if (!(id in status)) throw new Error(`No brain "${id}" in the catalogue.`);
      status[id] = "ready";
      return { id, port: 1, pid: 1 };
    },
    async stop(id) {
      status[id] = "idle";
      return { id };
    },
    async chat(id, messages, opts) {
      const call = { id, system: messages[0]?.content ?? "", user: messages.find((m) => m.role === "user")?.content ?? "", last: messages.at(-1), messages, opts };
      calls.push(call);
      busy[id] = (busy[id] ?? 0) + 1;
      peak[id] = Math.max(peak[id] ?? 0, busy[id]);
      await sleep(3);
      try {
        return script(call);
      } finally {
        busy[id]--;
      }
    },
    async stopAll() {},
  };
}

/** The script of the main quest: two tasks, one done with a tool, one that falls and is halved. */
function mainScript({ id, system, user, last }) {
  if (/You judge a worker/.test(system)) return say(JSON.stringify({ score: id === TALK ? 0.9 : 0.7, verdict: "pass", note: `judged by ${id}` }));
  if (id === TALK) {
    if (/You plan a quest/.test(system)) {
      // The plan follows the quest text: a "loop forever" quest is one endless task,
      // otherwise the stars task and the ocean task when the quest names them (both by default).
      const stars = { task: "Count the stars and write the number to stars.txt", finish: "stars.txt holds the number", rubric: ["stars.txt exists", "the number is verified", "nothing else changed"] };
      const ocean = { task: "Chart the ocean currents into ocean.md", finish: "ocean.md lists the currents", rubric: ["ocean.md exists", "the currents are named", "sources are listed", "nothing is invented"] };
      let tasks;
      if (/loop forever/i.test(user)) tasks = [{ task: "loop forever", finish: "never", rubric: ["it keeps going"] }];
      else {
        tasks = [];
        if (/stars/i.test(user)) tasks.push(stars);
        if (/chart the ocean/i.test(user)) tasks.push(ocean);
        if (tasks.length === 0) tasks = [stars, ocean];
      }
      return say(`Here is the plan:\n\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``);
    }
    if (/You split one task/.test(system)) return say(JSON.stringify({ a: "Chart the Atlantic currents into ocean.md", b: "Chart the Pacific currents into ocean.md" }));
  }
  if (id === WORKER) {
    if (/ocean/i.test(user)) return last.role === "tool" ? say("FALL: the ocean is too wide for one worker") : callTool("write_file", { path: "ocean.md", content: "# currents\n" });
    if (/loop forever/i.test(user)) return callTool("glob", { pattern: "*.txt" });
    return last.role === "tool" ? say(JSON.stringify({ status: "done", summary: "Counted 7 stars and wrote stars.txt.", verified: ["stars.txt holds 7"], files: ["stars.txt"] })) : callTool("write_file", { path: "stars.txt", content: "7\n" });
  }
  if (id === OFFSPRING) return say(JSON.stringify({ status: "done", summary: `Charted: ${taskOf(user)}`, verified: ["ocean.md read"] }));
  return say("?");
}

function setup({ script = mainScript, hardware = fakeHardware([cold()]), ...opts } = {}) {
  resetIds();
  const root = mkdtempSync(path.join(os.tmpdir(), "chronos-quest-"));
  const bus = new Bus();
  const brains = fakeBrains(script);
  const runner = createRunner({ root, brains, hardware, bus, coolPollMs: 2, ...opts });
  return { root, bus, brains, runner, types: () => bus.history.map((e) => e.type), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("workerCap, parsePlan, parseJudgement and questStatus", () => {
  assert.equal(workerCap(cold(), { parallel: 2 }), 2, "three fit, the brain has two slots");
  assert.equal(workerCap(cold(), { parallel: 4 }), 3, "(11288 - 512) / 3300");
  assert.equal(workerCap({ ...cold(), vram: { ...cold().vram, freeMiB: 3000 } }, { parallel: 2 }), 1, "at least one");
  assert.equal(workerCap(hot(), { parallel: 2 }), 0, "none while hot");
  assert.equal(workerCap(null), 1);

  const plan = parsePlan('{"tasks":[{"task":"a","finish":"f","rubric":["1","2"]},{"task":" ","rubric":[]},{"task":"b"}]}');
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { task: "a", finish: "f", rubric: ["1", "2", DEFAULT_RUBRIC[0]] });
  assert.equal(plan[1].finish, "the task is done and reported");
  assert.deepEqual(plan[1].rubric, DEFAULT_RUBRIC.slice(0, 3));
  assert.equal(parsePlan("no plan here"), null);
  assert.equal(parsePlan('{"tasks":[]}'), null);
  assert.deepEqual(fallbackPlan("do it"), [{ task: "do it", finish: "the task is done and reported", rubric: DEFAULT_RUBRIC }]);

  assert.deepEqual(parseJudgement('{"score": 1.4, "verdict": "pass", "note": "n"}'), { score: 1, verdict: "pass", note: "n" });
  assert.deepEqual(parseJudgement("score {\"score\": \"0.3\"}"), { score: 0.3, verdict: "fail", note: "" });
  assert.equal(parseJudgement("nope"), null);

  const done = { id: "a", status: "done" };
  const fell = { id: "b", status: "fell" };
  assert.equal(questStatus([done, fell], [{ id: "a", score: 0.9 }]), "done");
  assert.equal(questStatus([done], [{ id: "a", score: 0.2 }]), "partial", "a done report the judge failed is partial");
  assert.equal(questStatus([done], [{ id: "a", score: 0.2, advisory: true }]), "done", "an advisory failure cannot demote a done report");
  assert.equal(questStatus([done, { id: "c", status: "blocked" }], []), "partial");
  assert.equal(questStatus([{ id: "c", status: "blocked" }], []), "blocked");
  assert.equal(questStatus([fell], []), "blocked");
  assert.equal(questStatus([done], [], { stopped: true }), "stopped");
  assert.match(advisorySummary([{ id: "a", by: OFFSPRING, score: 0, verdict: "fail", note: "too strict", advisory: true }]), /Advisory judgement was advisory.*a by qwen3\.5-0\.8b: 0 fail - too strict/);
});

test("a quest: the titan plans, Prometheans run to the cap, a fall splits into two Offspring with the partial state, a different brain judges, the trail chains, the events come in order", async () => {
  const { root, bus, brains, runner, types, cleanup } = setup();
  try {
    const report = await runner.run({ id: "q-1", task: "Count the stars and chart the ocean", by: "someone" });
    assert.equal(report.status, "done");
    assert.equal(report.plan.length, 2, "the plan parsed out of the fenced block");
    assert.equal(report.plan[1].rubric.length, 4);
    assert.equal(report.splits, 1);

    // spawned: the titan, two Prometheans, two Offspring, in Hephaestus's shape
    const spawned = bus.history.filter((e) => e.type === "agent.spawned");
    const titan = spawned[0];
    assert.match(titan.id, /^wisp:ck-/);
    assert.equal(titan.tier, "titan");
    assert.deepEqual([titan.kind, titan.arm, titan.vendor, titan.brain, titan.quest, titan.parent], ["wisp", "chronos", "chronos", TALK, "q-1", null]);
    const prometheans = spawned.filter((e) => e.tier === "promethean");
    assert.equal(prometheans.length, 2);
    for (const p of prometheans) {
      assert.match(p.id, /^wisp:cp-/);
      assert.equal(p.brain, WORKER);
      assert.equal(p.parent, titan.id);
      assert.equal(p.depth, 0);
    }
    assert.equal(brains.peak[WORKER], 2, "both Prometheans ran at once under a cap of 2");
    const offspring = spawned.filter((e) => e.tier === "offspring");
    assert.equal(offspring.length, 2);

    // the fall and the split
    const fell = report.reports.find((r) => r.status === "fell");
    assert.ok(fell, "one Promethean fell");
    assert.equal(fell.tier, "promethean");
    assert.match(fell.why, /too wide/);
    assert.deepEqual(fell.files, ["ocean.md"]);
    const split = bus.history.find((e) => e.type === "agent.split");
    assert.equal(split.id, fell.id);
    assert.deepEqual(split.children, offspring.map((o) => o.id));
    assert.equal(split.depth, 1);
    for (const o of offspring) {
      assert.match(o.id, /^wisp:co-/);
      assert.equal(o.brain, OFFSPRING);
      assert.equal(o.parent, fell.id);
      assert.equal(o.depth, 1);
    }
    const children = report.reports.filter((r) => r.tier === "offspring");
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((c) => c.task), ["Chart the Atlantic currents into ocean.md", "Chart the Pacific currents into ocean.md"], "the titan halved the task");
    assert.ok(children.every((c) => c.status === "done" && c.depth === 1 && c.parent === fell.id));

    // the partial state reached both children
    const offCalls = brains.calls.filter((c) => c.id === OFFSPRING && /You are an Offspring/.test(c.system));
    assert.equal(offCalls.length, 2);
    for (const c of offCalls) {
      assert.match(c.user, /Starting state/);
      assert.match(c.user, /Why the parent fell: .*too wide/);
      assert.match(c.user, /Files it touched: ocean\.md/);
      assert.match(c.user, /write_file path="ocean\.md"/);
      assert.ok(c.opts.tools?.length > 0, "the Offspring got the tools");
    }

    // the tools really ran in the project root
    assert.equal(readFileSync(path.join(root, "stars.txt"), "utf8"), "7\n");
    assert.equal(readFileSync(path.join(root, "ocean.md"), "utf8"), "# currents\n");
    const stars = report.reports.find((r) => r.tier === "promethean" && r.status === "done");
    assert.deepEqual(stars.files, ["stars.txt"]);

    // a different brain than the author judged each finished report
    assert.equal(report.judged.length, 3, "the done Promethean and both Offspring; the fallen one is not judged");
    for (const j of report.judged) assert.notEqual(j.by, j.author, `${j.id} judged by its author`);
    assert.deepEqual(report.judged.find((j) => j.id === stars.id), { id: stars.id, tier: "promethean", author: WORKER, by: TALK, score: 0.9, verdict: "pass", note: `judged by ${TALK}` });
    for (const c of children) {
      const j = report.judged.find((x) => x.id === c.id);
      assert.deepEqual([j.author, j.by, j.score], [OFFSPRING, WORKER, 0.7]);
    }
    const judgeCalls = brains.calls.filter((c) => /You judge a worker/.test(c.system));
    assert.deepEqual(judgeCalls.map((c) => c.id).sort(), [TALK, WORKER, WORKER].sort());
    assert.match(judgeCalls[0].user, /Rubric:\n1\. /);

    // the trail
    assert.ok(existsSync(report.trail.file));
    assert.equal(report.trail.prev, "");
    assert.match(report.trail.name, /^\d{4}-\d{2}-\d{2}-quest-q-1-count-the-stars/);
    const text = readFileSync(report.trail.file, "utf8");
    assert.match(text, /^---\ntitle: "quest q-1: Count the stars and chart the ocean"\n/);
    assert.match(text, /\*\*Ask:\*\* Count the stars and chart the ocean/);
    assert.match(text, /\*\*By:\*\* felipe/);
    assert.ok(text.includes(`- ${fell.id} (promethean, ${WORKER}, depth 0, under ${titan.id}): fell`));
    assert.ok(text.includes(`judged 0.9 pass by ${TALK}: judged by ${TALK}`));
    assert.ok(text.includes("rubric: the currents are named"));
    assert.deepEqual(verifyChain(runner.trailDir), { ok: true, entries: 1, broken: [] });

    // the events, in order
    const t = types();
    assert.deepEqual(t.slice(0, 3), ["quest.running", "quest.phase", "agent.spawned"], "the runner takes it, the plan phase opens, the titan rises");
    assert.deepEqual(t.slice(-2), ["agent.done", "quest.done"]);
    // with no tiers configured the quest is m on the brains in the slots, and says so
    const tier = { titan: TALK, promethean: WORKER, offspring: OFFSPRING, judge: TALK };
    assert.deepEqual(bus.history[0], { ...bus.history[0], type: "quest.running", id: "q-1", size: "m", tier });
    assert.deepEqual(bus.history.filter((e) => e.type === "quest.phase").map((e) => [e.id, e.phase, e.brain]), [["q-1", "plan", TALK], ["q-1", "work", WORKER], ["q-1", "judge", TALK]]);
    assert.equal(report.size, "m");
    assert.deepEqual(report.tier, tier);
    assert.equal(report.answer, undefined, "an m quest's summary lists its reports; no answer is written");
    const at = (pred) => bus.history.findIndex(pred);
    const fellDone = at((e) => e.type === "agent.done" && e.id === fell.id);
    const splitAt = at((e) => e.type === "agent.split");
    const firstChild = at((e) => e.type === "agent.spawned" && e.tier === "offspring");
    const childDone = at((e) => e.type === "agent.done" && e.tier === "offspring");
    const titanDone = at((e) => e.type === "agent.done" && e.id === titan.id);
    assert.ok(0 < fellDone && fellDone < splitAt && splitAt < firstChild && firstChild < childDone && childDone < titanDone, `order: ${t.join(" ")}`);
    assert.equal(bus.history.filter((e) => e.type === "agent.done").length, 5, "titan, two Prometheans (the fallen one once), two Offspring");
    const done = bus.history.at(-1);
    assert.equal(done.id, "q-1");
    assert.equal(done.status, "done");
    assert.equal(done.size, "m");
    assert.deepEqual(done.tier, tier);
    assert.equal(done.report.status, "done");
    assert.equal(done.trail, report.trail.name);
    assert.ok(bus.history.some((e) => e.type === "log" && /planned 2 tasks/.test(e.text)));
    assert.ok(bus.history.some((e) => e.type === "log" && e.cap === 2));
    assert.deepEqual(runner.running(), []);
  } finally {
    cleanup();
  }
});

test("a second quest chains on the first in the trail", async () => {
  const { runner, cleanup } = setup();
  try {
    const a = await runner.run({ id: "q-a", task: "Count the stars", by: "someone" });
    const b = await runner.run({ id: "q-b", task: "Count the stars again", by: "someone" });
    assert.equal(b.trail.prev, a.trail.hash);
    const chain = readChain(runner.trailDir);
    assert.deepEqual(chain.map((e) => e.meta.title), ["quest q-a: Count the stars", "quest q-b: Count the stars again"]);
    assert.deepEqual(verifyChain(runner.trailDir), { ok: true, entries: 2, broken: [] });
  } finally {
    cleanup();
  }
});

test("the cap follows the hardware: tight VRAM runs one Promethean at a time", async () => {
  const tight = { ...cold(), vram: { ...cold().vram, usedMiB: 8788, freeMiB: 3500 } };
  const { brains, bus, runner, cleanup } = setup({ hardware: fakeHardware([tight]) });
  try {
    const report = await runner.run({ id: "q-2", task: "Count the stars and chart the ocean" });
    assert.equal(report.status, "done");
    assert.equal(report.plan.length, 2);
    assert.equal(brains.peak[WORKER], 1, "one lane");
    assert.ok(bus.history.some((e) => e.type === "log" && e.cap === 1));
  } finally {
    cleanup();
  }
});

test("a hot GPU makes the quest wait for it to cool; one that stays hot reports blocked", async () => {
  const waits = setup({ hardware: fakeHardware([hot(), hot(), cold()]) });
  try {
    const report = await waits.runner.run({ id: "q-3", task: "Count the stars" });
    assert.equal(report.status, "done");
    const t = waits.types();
    // the wait shows either as the pacing before the titan's first call or as the worker cap's hold
    const hotLog = waits.bus.history.findIndex((e) => e.type === "log" && (e.hot || e.pace));
    const firstWorker = waits.bus.history.findIndex((e) => e.type === "agent.spawned" && e.tier === "promethean");
    assert.ok(hotLog > 0 && hotLog < firstWorker, `waited before spawning: ${t.join(" ")}`);
    assert.match(waits.bus.history[hotLog].text, /junction is at 95 C/);
  } finally {
    waits.cleanup();
  }

  const stays = setup({ hardware: fakeHardware([hot()]), coolMaxMs: 10 });
  try {
    const report = await stays.runner.run({ id: "q-4", task: "Count the stars" });
    assert.equal(report.status, "blocked");
    assert.match(report.summary, /No Promethean could start.*95 C/);
    assert.deepEqual(report.reports, []);
    assert.equal(stays.bus.history.filter((e) => e.type === "agent.spawned").length, 1, "only the titan");
    assert.equal(stays.bus.history.at(-1).type, "quest.done");
    assert.equal(stays.bus.history.at(-1).status, "blocked");
    assert.ok(existsSync(report.trail.file), "the trail still records it");
    assert.equal(stays.brains.calls.filter((c) => c.id === WORKER).length, 0);
  } finally {
    stays.cleanup();
  }
});

test("a fall at the depth cap is blocked, not split again", async () => {
  assert.equal(MAX_DEPTH, 2, "Lite splits a fall at most two deep (lite/edition.json)");
  const falling = (call) => {
    if (/You judge a worker/.test(call.system)) return say('{"score": 0.1, "verdict": "fail", "note": "nothing done"}');
    if (call.id === TALK && /You plan a quest/.test(call.system)) return say('{"tasks":[{"task":"Chart the ocean","finish":"f","rubric":["a","b","c"]}]}');
    if (call.id === TALK && /You split one task/.test(call.system)) return say("I cannot split that.");
    return say("FALL: too big");
  };
  const deep = setup({ script: falling });
  try {
    const report = await deep.runner.run({ id: "q-5", task: "Chart the ocean" });
    assert.equal(report.status, "blocked");
    assert.equal(report.splits, 3, "1 + 2 falls split; the 4 at depth 2 (Lite's cap) do not");
    const blocked = report.reports.filter((r) => r.status === "blocked");
    assert.equal(blocked.length, 4);
    assert.ok(blocked.every((r) => r.depth === 2 && r.tier === "offspring" && /fell at depth 2, the cap/.test(r.blocked)));
    assert.equal(report.reports.filter((r) => r.status === "fell").length, 3);
    assert.equal(Math.max(...deep.bus.history.filter((e) => e.type === "agent.spawned").map((e) => e.depth)), 2);
    assert.equal(deep.bus.history.filter((e) => e.type === "agent.split").length, 3);
    assert.equal(report.judged.length, 4, "the blocked ones are judged, the fallen are not");
    assert.ok(report.judged.every((j) => j.by === WORKER && j.author === OFFSPRING));
    // the titan could not halve the task, so the mechanical split did
    assert.deepEqual(
      report.reports.filter((r) => r.depth === 1).map((r) => r.task),
      ["First half of: Chart the ocean", "Second half of: Chart the ocean (the first half is done by another worker)"],
    );
  } finally {
    deep.cleanup();
  }

  const shallow = setup({ script: falling, maxDepth: 1 });
  try {
    const report = await shallow.runner.run({ id: "q-6", task: "Chart the ocean" });
    assert.equal(report.splits, 1);
    assert.equal(report.reports.filter((r) => r.status === "blocked").length, 2);
    assert.equal(report.reports.length, 3);
  } finally {
    shallow.cleanup();
  }
});

test("the plan falls back to the whole quest when it does not parse, and an unparsed judgement leaves a done report partial", async () => {
  const vague = (call) => {
    if (call.id === TALK) return say("I would rather not answer in JSON.");
    if (call.id === WORKER) return say('{"status":"done","summary":"did it","verified":["x"]}');
    return say("?");
  };
  const { brains, runner, cleanup } = setup({ script: vague });
  try {
    const report = await runner.run({ id: "q-7", task: "Sweep the floor" });
    assert.deepEqual(report.plan, fallbackPlan("Sweep the floor"));
    assert.equal(report.reports.length, 1);
    assert.equal(report.reports[0].status, "done");
    assert.equal(report.reports[0].task, "Sweep the floor");
    assert.deepEqual(report.judged.map((j) => [j.by, j.score, j.verdict]), [[TALK, 0, "unjudged"]]);
    assert.equal(report.status, "partial");
    const planCall = brains.calls.find((c) => /You plan a quest/.test(c.system));
    assert.equal(planCall.opts.json_schema.name, "plan");
    assert.match(planCall.user, /^Quest:\nSweep the floor$/);
  } finally {
    cleanup();
  }
});

test("stop halts the workers between turns and the quest reports stopped", async () => {
  const { bus, brains, runner, cleanup } = setup();
  try {
    assert.equal(runner.stop("q-nothing"), false);
    const running = runner.run({ id: "q-8", task: "loop forever" });
    while (brains.calls.filter((c) => c.id === WORKER).length < 2) await sleep(2);
    assert.deepEqual(runner.running(), ["q-8"]);
    assert.equal(runner.stop("q-8"), true);
    const report = await running;
    assert.equal(report.status, "stopped");
    assert.match(report.summary, /Stopped by the owner/);
    assert.equal(report.reports.length, 1);
    assert.equal(report.reports[0].status, "fell");
    assert.equal(report.reports[0].why, "stopped");
    assert.ok(brains.calls.filter((c) => c.id === WORKER).length < 12, "it did not run its turns out");
    assert.equal(bus.history.filter((e) => e.type === "agent.split").length, 0, "a stopped worker is not split");
    assert.deepEqual(report.judged, []);
    assert.equal(bus.history.at(-1).type, "quest.done");
    assert.equal(bus.history.at(-1).status, "stopped");
    assert.deepEqual(runner.running(), []);
  } finally {
    cleanup();
  }
});

test("dry run through the server: POST /quests runs to quest.done, GET shows the report, the trail verifies, /stop halts a running one", async () => {
  const { root, bus, runner, cleanup } = setup();
  const app = createServer({ root, port: 0, bus, brains: fakeBrains(mainScript), hardware: fakeHardware([cold()]), runner });
  const port = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const finished = (id) =>
    new Promise((resolve) => {
      const seen = bus.history.find((e) => e.type === "quest.done" && e.id === id);
      if (seen) return resolve(seen);
      bus.on("quest.done", function on(e) {
        if (e.id !== id) return;
        bus.off("quest.done", on);
        resolve(e);
      });
    });
  try {
    const { status, body } = await call("POST", "/quests", { task: "Count the stars and chart the ocean", by: "someone" });
    assert.equal(status, 202);
    const done = await finished(body.id);
    assert.equal(done.status, "done");
    const one = (await call("GET", `/quests/${body.id}`)).body;
    assert.equal(one.status, "done");
    assert.equal(one.report.status, "done");
    assert.equal(one.report.reports.length, 4, "two Prometheans, one fell into two Offspring");
    assert.equal(one.report.judged.length, 3);
    assert.match(one.summary, /3 reports from 4 agents, 1 split/);
    assert.ok(existsSync(path.join(root, "brain", "docs-trail", one.report.trail.name)));
    assert.deepEqual(verifyChain(path.join(root, "brain", "docs-trail")), { ok: true, entries: 1, broken: [] });
    assert.deepEqual((await call("GET", "/health")).body.quests, { queued: 0, running: 0 });

    // what Hephaestus's driver follows is the sequence it always was; the new events sit between
    const all = bus.history.filter((e) => e.type !== "log").map((e) => e.type);
    const added = ["quest.queued", "quest.running", "quest.phase"];
    const t = all.filter((x) => !added.includes(x));
    assert.equal(t[0], "quest.started");
    assert.deepEqual(t.slice(1, 4), ["agent.spawned", "agent.spawned", "agent.spawned"], "the titan and two Prometheans");
    assert.ok(all.indexOf("quest.running") > all.indexOf("quest.started") && all.indexOf("quest.running") < all.indexOf("agent.spawned"));
    assert.ok(t.indexOf("agent.split") > t.indexOf("agent.done"));
    assert.deepEqual(t.slice(-2), ["agent.done", "quest.done"]);

    // a running quest is stopped through the route
    const loop = (await call("POST", "/quests", { task: "loop forever" })).body;
    while ((await call("GET", `/quests/${loop.id}`)).body.status !== "running") await sleep(2);
    // wait for its first worker, so the stop lands on a running Promethean and not before one exists
    while (!bus.history.some((e) => e.type === "agent.spawned" && e.quest === loop.id && e.tier === "promethean")) await sleep(2);
    const stop = await call("POST", `/quests/${loop.id}/stop`);
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopping, true);
    const stopped = await finished(loop.id);
    assert.equal(stopped.status, "stopped");
    const again = (await call("GET", `/quests/${loop.id}`)).body;
    assert.equal(again.status, "stopped");
    assert.equal(again.stop, true);
    assert.equal(again.report.reports[0].why, "stopped");
    assert.deepEqual(verifyChain(path.join(root, "brain", "docs-trail")), { ok: true, entries: 2, broken: [] });
  } finally {
    await app.close();
    cleanup();
  }
});

test("pacing: no GPU call starts while the junction is at or above PACE_C, and a CPU brain is never held", async () => {
  const warm = () => ({ ...cold(), heat: { junctionC: PACE_C + 4, edgeC: 70, critC: 100, cpuC: 80, hot: false } });
  const run = setup({ hardware: fakeHardware([warm(), warm(), warm(), cold()]) });
  try {
    const report = await run.runner.run({ id: "q-pace", task: "Count the stars" });
    assert.equal(report.status, "done");
    const paced = run.bus.history.filter((e) => e.type === "log" && e.pace);
    assert.ok(paced.length >= 1, "a pacing line was logged");
    assert.match(paced[0].text, new RegExp(`junction is at ${PACE_C + 4} C.*under ${PACE_C} C`));
    const firstCall = run.bus.history.findIndex((e) => e.type === "log" && /planned/.test(e.text ?? ""));
    assert.ok(run.bus.history.indexOf(paced[0]) < firstCall || firstCall < 0, "it waited before the titan planned");
  } finally {
    run.cleanup();
  }
});

test("a brain the heat watchdog stopped is restarted after the card cools, and the call goes through", async () => {
  let gone = 1;
  const script = (call) => {
    if (call.id === WORKER && gone > 0) {
      gone--;
      throw new Error("fetch failed");
    }
    return mainScript(call);
  };
  const run = setup({ script, hardware: fakeHardware([cold()]) });
  try {
    const report = await run.runner.run({ id: "q-gone", task: "Count the stars" });
    assert.equal(report.status, "done", "the worker survived the stopped brain");
    assert.equal(report.reports.length, 1);
    assert.equal(report.reports[0].status, "done");
    assert.ok(run.bus.history.some((e) => e.type === "log" && /is gone .*starting it again/.test(e.text ?? "")));
    assert.equal(run.bus.history.filter((e) => e.type === "agent.split").length, 0, "a stopped brain never splits a task");
  } finally {
    run.cleanup();
  }
});

test("two planned tasks that name the same file run one after another, the second from the first's report", async () => {
  assert.deepEqual([...filesNamed("Write scratch/proof.md, then read ./README.md and notes.txt")], ["scratch/proof.md", "README.md", "notes.txt"]);
  assert.equal(sharesAFile([{ task: "Write line 1 of scratch/proof.md" }, { task: "Append line 2 to scratch/proof.md" }]), "scratch/proof.md");
  assert.equal(sharesAFile([{ task: "Write a.md" }, { task: "Write b.md" }]), null);

  const script = (call) => {
    if (call.id === TALK && /You plan a quest/.test(call.system)) {
      return say(JSON.stringify({ tasks: [
        { task: "Write line 1 to scratch/proof.md", finish: "f", rubric: ["a", "b", "c"] },
        { task: "Write line 2 to scratch/proof.md", finish: "f", rubric: ["a", "b", "c"] },
      ] }));
    }
    if (call.id === WORKER) {
      return call.last.role === "tool"
        ? say(JSON.stringify({ status: "done", summary: `did: ${taskOf(call.user)}`, verified: ["read back"], files: ["scratch/proof.md"] }))
        : callTool("write_file", { path: "scratch/proof.md", content: "x\n" });
    }
    return mainScript(call);
  };
  const run = setup({ script });
  try {
    const report = await run.runner.run({ id: "q-one-file", task: "Write scratch/proof.md with two lines" });
    assert.equal(report.status, "done");
    assert.equal(run.brains.peak[WORKER], 1, "never two workers on the file at once");
    assert.ok(run.bus.history.some((e) => e.type === "log" && /name the same file \(scratch\/proof\.md\)/.test(e.text ?? "")));
    const second = run.brains.calls.find((c) => c.id === WORKER && /line 2/.test(c.user));
    assert.match(second.user, /already did: did: Write line 1/, "the second starts from the first's report");
  } finally {
    run.cleanup();
  }
});

test("a fallen worker hands its Offspring at most STATE_MAX_CHARS, keeping the newest steps", () => {
  const work = Array.from({ length: 12 }, (_, i) => ({ name: "glob", args: { pattern: `step${i}/**` }, ok: false, out: "x".repeat(5000) }));
  const state = partialState({ why: "too big", files: ["a.md"], work });
  assert.ok(state.length <= STATE_MAX_CHARS, `${state.length} chars`);
  assert.match(state, /Why the parent fell: too big/);
  assert.match(state, /step11/, "the newest step survives");
});

// ---- sizes: the tiers, the three phases around a Titan that is alone on the GPU, the caps ----

const TIERS = {
  s: { titan: null, promethean: WORKER, offspring: OFFSPRING, maxTasks: 1, tokens: 16000, seconds: 900 },
  m: { titan: TALK, promethean: WORKER, offspring: OFFSPRING, maxTasks: 3, tokens: 64000, seconds: 2700 },
};
const TIER = {
  s: { titan: null, promethean: WORKER, offspring: OFFSPRING, judge: WORKER },
  m: { titan: TALK, promethean: WORKER, offspring: OFFSPRING, judge: TALK },
};

/**
 * Stand-in brains with the catalogue's tiers: the three of before, the main
 * brain (exclusive) and one that belongs to no tier. They are strict: a chat
 * to a brain that is not serving throws. Every start and stop is kept in
 * `moves`, every chat in `calls` with which brains were serving then. They do
 * not apply the exclusive rule themselves, so the stops seen are the runner's;
 * with `rule` they do, as the real Brains does (an exclusive brain starts
 * alone, and any other start stops it), and say so as "rule stop <id>".
 */
function tieredBrains(script, { absent = [], up = [], refuse = () => null, tiers = TIERS, rule = false } = {}) {
  const ids = [TALK, WORKER, OFFSPRING];
  const status = Object.fromEntries(ids.map((id) => [id, up.includes(id) ? "ready" : "idle"]));
  const calls = [];
  const moves = [];
  const serving = () => ids.filter((id) => status[id] === "ready");
  return {
    calls,
    moves,
    status,
    catalogue: { tiers },
    list: () =>
      [
        { id: TALK, role: "talk", slot: "talk", parallel: 2, vramMiB: 6200 },
        { id: WORKER, role: "promethean", slot: "promethean", parallel: 2, vramMiB: 3300 },
        { id: OFFSPRING, role: "offspring", slot: "offspring", parallel: 4, ramMiB: 1400 },
      ].map((b) => ({ exclusive: false, ...b, status: status[b.id], present: !absent.includes(b.id) })),
    async start(id) {
      const why = refuse(id, serving());
      moves.push(why ? `refused ${id}` : `start ${id}`);
      if (why) throw new Error(why);
      if (rule && status[id] !== "ready") {
        for (const other of serving()) {
          if (other === id) continue;
          moves.splice(-1, 0, `rule stop ${other}`);
          status[other] = "idle";
        }
      }
      status[id] = "ready";
      return { id, port: 1, pid: 1 };
    },
    async stop(id) {
      moves.push(`stop ${id}`);
      status[id] = "idle";
      return { id };
    },
    async chat(id, messages, opts) {
      if (status[id] !== "ready") throw new Error(`Brain "${id}" is not serving.`);
      const call = { id, system: messages[0]?.content ?? "", user: messages.find((m) => m.role === "user")?.content ?? "", last: messages.at(-1), messages, opts, serving: serving() };
      calls.push(call);
      await sleep(3);
      return script(call);
    },
    async stopAll() {},
  };
}

/** The script of a sized quest: the main brain plans four tasks, judges a batch and writes the answer; the 4B halves a fall; the rest is mainScript. */
function sizedScript(call) {
  const { id, system, user } = call;
  if (id === WORKER && /You split one task/.test(system)) return say(JSON.stringify({ a: "Chart the Atlantic currents into ocean.md", b: "Chart the Pacific currents into ocean.md" }));
  return mainScript(call);
}

function sized({ script = sizedScript, hardware = fakeHardware([cold()]), brains: brainOpts = {}, ...opts } = {}) {
  resetIds();
  const root = mkdtempSync(path.join(os.tmpdir(), "chronos-sized-"));
  const bus = new Bus();
  const brains = tieredBrains(script, brainOpts);
  const runner = createRunner({ root, brains, hardware, bus, coolPollMs: 2, settleMs: 0, ...opts });
  const events = (type) => bus.history.filter((e) => e.type === type);
  return { root, bus, brains, runner, events, types: () => bus.history.filter((e) => e.type !== "log").map((e) => e.type), logs: () => events("log").map((e) => e.text ?? ""), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("parseJudgements, generatedTokens and questCaps", () => {
  const got = parseJudgements('```json\n{"judgements":[{"id":"wisp:cp-1","score":0.8,"verdict":"pass","note":"ok"},{"id":"wisp:cp-2","score":"0.2"},{"id":"x"},{"n":3,"score":2}]}\n```');
  assert.deepEqual([...got.keys()], ["wisp:cp-1", "wisp:cp-2", "3"]);
  assert.deepEqual(got.get("wisp:cp-1"), { score: 0.8, verdict: "pass", note: "ok" });
  assert.deepEqual(got.get("wisp:cp-2"), { score: 0.2, verdict: "fail", note: "" });
  assert.equal(got.get("3").score, 1, "clamped");
  assert.equal(parseJudgements("no json").size, 0);
  assert.equal(parseJudgements('{"score": 0.5}').size, 0, "a judgement with no id is nobody's");
  assert.equal(parseJudgements('{"id":"a","score":0.5}').size, 1, "one judgement alone is taken");

  assert.equal(generatedTokens({ usage: { completion_tokens: 12, prompt_tokens: 900 } }), 12, "what the brain generated, not what it read");
  assert.equal(generatedTokens({ content: "x".repeat(40) }), 10, "a rough count when the server sends none");
  assert.equal(generatedTokens({ content: "", toolCalls: [{ id: "c", name: "glob", arguments: {} }], usage: { prompt: 3 } }), Math.ceil(JSON.stringify([{ id: "c", name: "glob", arguments: {} }]).length / 4));
  assert.equal(generatedTokens(null), 0);

  assert.deepEqual(questCaps({ maxTasks: 3, tokens: 64000, seconds: 2700 }), { maxTasks: 3, tokens: 64000, seconds: 2700 });
  assert.deepEqual(questCaps({ maxTasks: 3, tokens: 64000, seconds: 2700 }, { tokens: 500 }), { maxTasks: 3, tokens: 500, seconds: 2700 });
  assert.deepEqual(questCaps({ maxTasks: 3 }, { tokens: "900", seconds: 60, maxTasks: 99 }), { maxTasks: 3, tokens: 900, seconds: 60 }, "a budget caps tokens and seconds, nothing else");
  assert.deepEqual(questCaps({ tokens: 10 }, { tokens: -1, seconds: "soon" }), { tokens: 10 }, "a budget that is no positive number is ignored");
});

test("a small quest: no plan and no Titan, one Promethean on the 4B judged by the 0.8B; the 9B never loads", async () => {
  const one = sized();
  try {
    const report = await one.runner.run({ id: "q-s", task: "Count the stars", by: "ui", size: "s" });
    assert.equal(report.status, "done");
    assert.equal(report.size, "s");
    assert.deepEqual(report.tier, TIER.s);
    assert.deepEqual(report.plan, fallbackPlan("Count the stars"));
    assert.deepEqual(report.titan, { id: null, brain: null });
    assert.equal(one.brains.calls.filter((c) => /You plan a quest/.test(c.system)).length, 0, "nobody plans");
    assert.deepEqual(one.brains.moves, [`start ${WORKER}`, `start ${OFFSPRING}`], "only the tier's two brains");
    assert.deepEqual(one.types(), ["quest.running", "quest.phase", "agent.spawned", "agent.done", "quest.phase", "quest.done"]);
    assert.deepEqual(one.events("quest.phase").map((e) => [e.phase, e.brain]), [["work", WORKER], ["judge", OFFSPRING]]);
    const [spawn] = one.events("agent.spawned");
    assert.deepEqual([spawn.tier, spawn.brain, spawn.parent, spawn.task], ["promethean", WORKER, null, "Count the stars"]);
    assert.deepEqual(report.judged.map((j) => [j.author, j.by, j.score]), [[WORKER, OFFSPRING, 0.7]], "the 0.8B judges the 4B, never the author");
    assert.match(report.summary, /^1 report from 1 agent, 0 splits\./);
    assert.deepEqual(report.caps, { maxTasks: 1, tokens: 16000, seconds: 900, turns: 25 });
    assert.ok(one.logs().some((l) => /size s: no plan, the whole quest is one task for one Promethean/.test(l)));
    assert.deepEqual([one.bus.history.at(-1).size, one.bus.history.at(-1).tier], ["s", TIER.s]);
    const text = readFileSync(report.trail.file, "utf8");
    assert.ok(text.includes(`**Size:** s (Promethean ${WORKER}, Offspring ${OFFSPRING}, judge ${WORKER})`));
    assert.match(text, /No Titan; 0 split\(s\)/);
  } finally {
    one.cleanup();
  }

  // a fall still splits: the 4B halves its own task for two Offspring, and judges them
  const falls = sized();
  try {
    const report = await falls.runner.run({ id: "q-s2", task: "Chart the ocean currents into ocean.md", size: "s" });
    assert.equal(report.status, "done");
    assert.equal(report.splits, 1);
    assert.deepEqual(falls.events("agent.spawned").map((e) => [e.tier, e.brain]), [["promethean", WORKER], ["offspring", OFFSPRING], ["offspring", OFFSPRING]]);
    assert.deepEqual(falls.brains.calls.filter((c) => /You split one task/.test(c.system)).map((c) => c.id), [WORKER]);
    assert.deepEqual(report.judged.map((j) => [j.author, j.by]), [[OFFSPRING, WORKER], [OFFSPRING, WORKER]]);
    assert.ok(!falls.brains.moves.some((m) => m.includes(TALK)));
  } finally {
    falls.cleanup();
  }
});

test("a smaller judge is advisory, but a larger judge keeps full force", async () => {
  const failingJudges = (call) => {
    if (/You judge a worker/.test(call.system)) return say(JSON.stringify({ score: 0, verdict: "fail", note: `failed by ${call.id}` }));
    if (call.id === WORKER && /You split one task/.test(call.system)) return say(JSON.stringify({ a: "Chart the Atlantic currents into ocean.md", b: "Chart the Pacific currents into ocean.md" }));
    return mainScript(call);
  };

  const small = sized({ script: failingJudges });
  try {
    const report = await small.runner.run({ id: "q-advisory", task: "Count the stars", size: "s" });
    assert.equal(report.status, "done", "the 0.8B's failed judgement cannot demote the 4B's done report");
    assert.equal(report.judged.length, 1);
    assert.deepEqual(
      { by: report.judged[0].by, author: report.judged[0].author, score: report.judged[0].score, verdict: report.judged[0].verdict, advisory: report.judged[0].advisory },
      { by: OFFSPRING, author: WORKER, score: 0, verdict: "fail", advisory: true },
    );
    assert.match(report.judged[0].advisoryReason, /catalogue memory/);
    assert.match(report.summary, /Advisory judgement was advisory.*qwen3\.5-0\.8b: 0 fail - failed by qwen3\.5-0\.8b/);
    const text = readFileSync(report.trail.file, "utf8");
    assert.match(text, /advisory judgement 0 fail by qwen3\.5-0\.8b: failed by qwen3\.5-0\.8b/);
  } finally {
    small.cleanup();
  }

  const split = sized({ script: failingJudges });
  try {
    const report = await split.runner.run({ id: "q-full-force", task: "Chart the ocean currents into ocean.md", size: "s" });
    assert.equal(report.status, "partial", "the 4B's failed judgement of the 0.8B still counts");
    assert.equal(report.splits, 1);
    assert.deepEqual(report.judged.map((j) => [j.author, j.by, j.score, j.verdict, j.advisory ?? false]), [
      [OFFSPRING, WORKER, 0, "fail", false],
      [OFFSPRING, WORKER, 0, "fail", false],
    ]);
    assert.doesNotMatch(report.summary, /Advisory/);
  } finally {
    split.cleanup();
  }
});

test("the size: auto reads the task's words, m runs on the 9B, an l runs as m and says so, and a missing 9B falls back to s", async () => {
  // auto, a small job
  const auto = sized();
  try {
    const quest = { id: "q-auto", task: "Rename a.txt to b.txt" };
    const report = await auto.runner.run(quest);
    assert.equal(report.size, "s");
    assert.equal(quest.size, "s");
    assert.ok(auto.logs().some((l) => /^sized s by the task's words \(a short single ask, 1 word for a small job\)$/.test(l)));
    assert.equal(auto.events("quest.running")[0].size, "s");
  } finally {
    auto.cleanup();
  }

  // auto, words that ask for thought: full Chronos would make it l, Lite makes it m
  const up = sized();
  try {
    const report = await up.runner.run({ id: "q-auto-l", task: "Plan the survey and compare both designs of the stars" });
    assert.equal(report.size, "m");
    assert.equal(report.status, "done");
    assert.equal(report.answer, undefined, "no answer is written: that was the l Titan's job");
    assert.equal(report.downgraded, undefined, "auto never asked for l");
  } finally {
    up.cleanup();
  }

  // m: the 9B plans up to three tasks, splits and judges; the main brain is never loaded
  const m = sized();
  try {
    const report = await m.runner.run({ id: "q-m", task: "Count the stars and chart the ocean", size: "m" });
    assert.equal(report.status, "done");
    assert.equal(report.size, "m");
    assert.deepEqual(report.tier, TIER.m);
    assert.equal(report.plan.length, 2);
    assert.equal(report.splits, 1);
    assert.deepEqual(m.brains.moves, [`start ${TALK}`, `start ${WORKER}`, `start ${OFFSPRING}`], "nothing is stopped");
    assert.deepEqual(m.brains.calls.filter((c) => /You split one task/.test(c.system)).map((c) => c.id), [TALK], "the Titan halves the fall");
    assert.deepEqual(report.judged.map((j) => j.by).sort(), [TALK, WORKER, WORKER].sort());
    assert.ok(report.judged.every((j) => !j.advisory), "the 9B judging the 4B and the 4B judging the 0.8B are full-force");
    assert.match(m.brains.calls[0].system, /into 1 to 3 tasks/);
    assert.equal(m.brains.calls[0].opts.maxTokens, 800);
    assert.match(report.summary, /^3 reports from 4 agents, 1 split\./);
    assert.deepEqual(m.events("quest.phase").map((e) => [e.phase, e.brain]), [["plan", TALK], ["work", WORKER], ["judge", TALK]]);
    assert.ok(!m.logs().some((l) => /^sized /.test(l)), "a size that was asked for is not explained");
  } finally {
    m.cleanup();
  }

  // l asked: Lite has no l, so it runs as m, and the log, quest.running, the quest and the report say so
  const large = sized();
  try {
    const quest = { id: "q-large", task: "Count the stars", size: "l" };
    const report = await large.runner.run(quest);
    assert.equal(report.status, "done");
    assert.equal(report.size, "m");
    assert.deepEqual(report.tier, TIER.m);
    assert.deepEqual(report.downgraded, { from: "l", to: "m" });
    assert.equal(quest.size, "m");
    assert.deepEqual(quest.downgraded, { from: "l", to: "m" });
    const line = large.events("log").find((e) => e.fallback);
    assert.equal(line.text, "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m");
    assert.equal(line.quest, "q-large");
    assert.deepEqual(large.events("quest.running").map((e) => [e.size, e.downgraded]), [["m", { from: "l", to: "m" }]]);
  } finally {
    large.cleanup();
  }

  // m asked and the 9B's file is missing: s, and a log line says so
  const missing = sized({ brains: { absent: [TALK] } });
  try {
    const report = await missing.runner.run({ id: "q-fall", task: "Count the stars", size: "m" });
    assert.equal(report.status, "done");
    assert.equal(report.size, "s");
    assert.equal(missing.events("log").find((e) => e.fallback).text, `size m: its Titan ${TALK} is not on disk; falling back to size s`);
    assert.ok(!missing.brains.moves.some((x) => x.includes(TALK)));
  } finally {
    missing.cleanup();
  }

  // nothing can run: the quest fails with the reason, and still ends with quest.done
  const dead = sized({ brains: { absent: [TALK, WORKER] } });
  try {
    const report = await dead.runner.run({ id: "q-dead", task: "Count the stars", size: "l" });
    assert.equal(report.status, "failed");
    assert.match(report.summary, /no size can run: size s: its Promethean brain qwen3\.5-4b is not on disk/);
    assert.deepEqual(dead.types(), ["quest.running", "quest.done"]);
    assert.deepEqual(dead.brains.moves, []);
  } finally {
    dead.cleanup();
  }
});

test("caps: the tier's tokens and seconds, or the quest's own budget, stop a quest that passes them with the reason; waits for a cool card are not counted", async () => {
  // every stand-in call generates 10 tokens: the plan and four turns pass a budget of 45
  const tokens = sized();
  try {
    const quest = { id: "q-cap", task: "loop forever", size: "m", budget: { tokens: 45 } };
    const report = await tokens.runner.run(quest);
    assert.equal(report.status, "stopped");
    assert.equal(report.why, "the quest passed its cap of 45 tokens (50 generated)");
    assert.equal(report.summary, "Stopped: the quest passed its cap of 45 tokens (50 generated); 1 agent had run.");
    assert.equal(report.usage.tokens, 50);
    assert.equal(tokens.brains.calls.length, 5, "no call after the cap");
    assert.deepEqual(report.caps, { maxTasks: 3, tokens: 45, seconds: 2700, turns: 25 }, "the budget is over the tier's cap");
    assert.equal(report.reports[0].why, "stopped");
    assert.deepEqual(report.judged, []);
    const done = tokens.bus.history.at(-1);
    assert.deepEqual([done.type, done.status, done.why], ["quest.done", "stopped", report.why]);
    assert.ok(tokens.events("log").some((e) => e.cap && /passed its cap of 45 tokens.*the workers finish their turn and halt/.test(e.text)));
    assert.match(readFileSync(report.trail.file, "utf8"), /\*\*Why:\*\* the quest passed its cap of 45 tokens/);
    assert.equal(tokens.events("agent.split").length, 0, "a capped worker is not split");
  } finally {
    tokens.cleanup();
  }

  // with no budget the tier's own cap holds
  const tier = sized({ brains: { tiers: { ...TIERS, s: { ...TIERS.s, tokens: 25 } } } });
  try {
    const report = await tier.runner.run({ id: "q-cap-s", task: "loop forever", size: "s" });
    assert.equal(report.status, "stopped");
    assert.equal(report.why, "the quest passed its cap of 25 tokens (30 generated)");
    assert.deepEqual(report.caps, { maxTasks: 1, tokens: 25, seconds: 900, turns: 25 });
  } finally {
    tier.cleanup();
  }

  // seconds: a quest that runs past its time is stopped between turns
  const time = sized();
  try {
    const report = await time.runner.run({ id: "q-time", task: "loop forever", size: "s", budget: { seconds: 0.02 } });
    assert.equal(report.status, "stopped");
    assert.match(report.why, /^the quest passed its cap of 0\.02 s of running time \(0(\.\d)? s, waits for a cool card not counted\)$/);
    assert.match(report.summary, /^Stopped: the quest passed its cap of 0\.02 s of running time/);
    assert.ok(time.brains.calls.length < 12, "it did not run its turns out");
  } finally {
    time.cleanup();
  }

  // a wait for a cool card longer than the cap does not stop the quest
  const warm = () => ({ ...cold(), heat: { junctionC: PACE_C + 3, edgeC: 70, critC: 100, cpuC: 80, hot: false } });
  const waits = sized({ hardware: fakeHardware([...Array.from({ length: 10 }, warm), cold()]), coolPollMs: 60 });
  try {
    const report = await waits.runner.run({ id: "q-wait", task: "Count the stars", size: "s", budget: { seconds: 0.4 } });
    assert.equal(report.status, "done", `${report.summary}`);
    assert.equal(report.why, undefined);
    assert.ok(report.usage.waitedSeconds >= 0.5, `waited ${report.usage.waitedSeconds} s`);
    assert.ok(report.usage.seconds < 0.4, `ran ${report.usage.seconds} s`);
    assert.match(readFileSync(report.trail.file, "utf8"), /s waiting for a cool card\)/);
  } finally {
    waits.cleanup();
  }
});

test("with no tiers configured a size other than m is ignored, and says so", async () => {
  const { bus, runner, cleanup } = setup();
  try {
    const quest = { id: "q-legacy", task: "Count the stars", size: "l", budget: { tokens: 100000 } };
    const report = await runner.run(quest);
    assert.equal(report.status, "done");
    assert.equal(report.size, "m");
    assert.equal(quest.size, "m");
    assert.ok(bus.history.some((e) => e.type === "log" && e.text === "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m"));
    assert.deepEqual(report.caps, { maxTasks: 3, tokens: 100000, turns: 25 }, "no tier caps; the quest's own budget and the turn cap still hold");
    assert.equal(trailBody(quest, report).includes("**Size:** m"), true);
  } finally {
    cleanup();
  }
});

test("the turn cap: a quest makes at most QUEST_TURNS brain calls, plan, work and judging together", async () => {
  assert.equal(QUEST_TURNS, 25, "Lite's cap (lite/edition.json)");
  const run = sized({ maxTurns: 6 });
  try {
    const report = await run.runner.run({ id: "q-turns", task: "loop forever", size: "m" });
    assert.equal(report.status, "stopped");
    assert.equal(report.why, "the quest passed its cap of 6 brain turns");
    assert.equal(run.brains.calls.length, 6, "the call past the cap is never made");
    assert.equal(report.usage.turns, 7, "the seventh was counted and refused");
    assert.equal(report.caps.turns, 6);
    assert.equal(run.events("agent.split").length, 0, "a capped worker is not split");
  } finally {
    run.cleanup();
  }
});
