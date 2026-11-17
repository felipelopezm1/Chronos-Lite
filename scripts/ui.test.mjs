// The UI's pure parts in Node, and the mock that drives the page: the brand (/edition into name,
// accent, words and avatar), the words (a rebrand never shows the runtime's inner names), the
// face's state (Chronos's order of weight) and its reactions, and the mock's scripted work, which
// must give every view and every face state something to show: a split, a stop, an error, a done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandOf, avatarOf, tintFilter, accentTokens, contrast, VOCABULARIES, DEFAULT_ACCENT, GROUNDS } from "../ui/brand.js";
import { setWords, sentence, plainText, W } from "../ui/lib/words.js";
import { moodOf, reactionOf, STATES, FAILED_MS } from "../ui/mood.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the two vocabularies name the same words", () => {
  assert.deepEqual(Object.keys(VOCABULARIES.plain).sort(), Object.keys(VOCABULARIES.chronos).sort());
  assert.equal(VOCABULARIES.chronos.planner, "titan");
  assert.equal(VOCABULARIES.plain.planner, "planner");
});

test("brandOf: the shipped brand is Chronos's essence; a company's brand gets plain words unless it asks", () => {
  const shipped = brandOf({ name: "Chronos Lite", vocabulary: "chronos", avatar: { kind: "face", frames: null, tint: null } });
  assert.equal(shipped.accent, DEFAULT_ACCENT);
  assert.equal(shipped.words.task, "quest");
  assert.deepEqual(shipped.avatar, { kind: "face", frames: null, tint: null });
  const acme = brandOf({ name: "Acme Agents", accent: "#7c3aed", avatar: { kind: "face", tint: "accent" } });
  assert.equal(acme.vocabulary, "plain");
  assert.equal(acme.words.helper, "helper");
  assert.equal(acme.avatar.tint, "#7c3aed", "tint accent is the brand's accent");
  const nw = brandOf({ name: "Northwind", vocabulary: "plain", words: { task: "request", nope: "x" }, avatar: { kind: "monogram", tint: "#fff" } });
  assert.equal(nw.words.task, "request");
  assert.equal(nw.words.nope, undefined, "only known words are renamed");
  assert.deepEqual(nw.avatar, { kind: "monogram", frames: null, tint: null });
});

test("avatarOf: frames only from this computer; tintFilter keeps greys grey and turns the hue", () => {
  assert.equal(avatarOf({ frames: "/brand/face" }).frames, "/brand/face/");
  assert.equal(avatarOf({ frames: "https://example.com/face/" }).frames, null);
  assert.equal(tintFilter(null), "");
  assert.match(tintFilter("#15803d"), /^hue-rotate\(-?\d+deg\) saturate\(/);
  assert.equal(tintFilter("#808080"), "saturate(0.12)");
});

test("accentTokens: the accent reads on both grounds", () => {
  for (const hex of [DEFAULT_ACCENT, "#7c3aed", "#15803d", "#facc15"]) {
    assert.ok(contrast(accentTokens(hex, "dark")["--red-hot"], GROUNDS.dark) >= 7, `${hex} hot on the dark ground`);
    assert.ok(contrast(accentTokens(hex, "light")["--red-hot"], "#ffffff") >= 4.5, `${hex} hot on white`);
  }
});

test("the words: Chronos's in the default brand, none of the runtime's inner names in a rebrand", () => {
  setWords(VOCABULARIES.chronos, "Chronos Lite", "chronos");
  assert.match(sentence({ type: "agent.spawned", tier: "titan", brain: "qwen3.5-9b" }), /the Titan takes the quest on the 9B brain/);
  setWords({ ...VOCABULARIES.plain, task: "request" }, "Acme Agents", "plain");
  const said = [
    sentence({ type: "agent.spawned", tier: "offspring", brain: "qwen3.5-0.8b", task: "the Promethean's half" }),
    sentence({ type: "quest.phase", id: "q-1", phase: "plan", brain: "qwen3.5-9b" }),
    plainText("the Titan planned 3 tasks for qwen3.5-4b on Chronos Lite; brains: 3; quests: 2"),
  ].join(" | ");
  assert.doesNotMatch(said, /\b(titans?|prometheans?|offspring|qwen[\w.-]*|brains?|quests?|Chronos)\b/i);
  assert.match(said, /Acme Agents/);
  assert.equal(W.task, "request");
  setWords(VOCABULARIES.chronos, "Chronos Lite", "chronos");
});

test("moodOf: Chronos's order of weight, with Lite's speaking and card wait", () => {
  const now = 1_000_000;
  assert.equal(moodOf({ lastActivity: now }, now), "idle");
  assert.equal(moodOf({ hold: { type: "heat.cutoff" }, quest: { status: "running" } }, now), "held");
  assert.equal(moodOf({ waiting: true }, now), "held");
  assert.equal(moodOf({ failedUntil: now + 1 }, now), "held");
  assert.equal(moodOf({ speakingUntil: now + 1, quest: { status: "running", phase: "plan" } }, now), "speaking");
  assert.equal(moodOf({ quest: { status: "running", phase: "plan" } }, now), "thinking");
  assert.equal(moodOf({ quest: { status: "running", phase: "judge" } }, now), "thinking");
  assert.equal(moodOf({ quest: { status: "running", phase: "work" } }, now), "working");
  assert.equal(moodOf({ quest: { status: "running", size: "s" } }, now), "working");
  assert.equal(moodOf({ typingUntil: now + 1 }, now), "listening");
  assert.equal(moodOf({ doneUntil: now + 1 }, now), "done");
  assert.equal(moodOf({ lastActivity: now - 11 * 60_000 }, now), "sleep");
  for (const s of ["idle", "held", "speaking", "thinking", "working", "listening", "done", "sleep"]) assert.ok(STATES.includes(s));
  assert.ok(FAILED_MS > 0);
});

test("reactionOf: a split tears her, a failure hits her, a stop jolts her, a result is said", () => {
  assert.deepEqual(reactionOf({ type: "agent.split" }), { displace: true });
  assert.equal(reactionOf({ type: "brain.failed" }).failed, true);
  assert.equal(reactionOf({ type: "quest.done", status: "failed" }).failed, true);
  assert.equal(reactionOf({ type: "quest.done", status: "stopped" }).glitch > 0, true);
  assert.equal(reactionOf({ type: "quest.done", status: "done", summary: "29 items" }).say, "29 items");
});

/** start the mock on a free port; answers its base URL and a stop */
async function mock(...args) {
  const child = spawn(process.execPath, [path.join(root, "scripts/mock-runtime.mjs"), "--port", "0", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    child.on("exit", (c) => reject(new Error(`the mock exited ${c}`)));
  });
  return { base, stop: () => child.kill("SIGTERM") };
}

test("the mock: /edition carries the brand's vocabulary and avatar; its work gives every face state something", async () => {
  const { base, stop } = await mock("--speed", "40", "--no-drop", "--brand", "lite/brands/northwind.json");
  try {
    const ed = await (await fetch(`${base}/edition`)).json();
    assert.equal(ed.vocabulary, "plain");
    assert.deepEqual(ed.avatar, { kind: "monogram" });
    assert.equal(ed.words.task, "request");
    const post = (task, size) => fetch(`${base}/quests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, size }) }).then((r) => r.json());
    const a = await post("Count the stars", "s");
    const b = await post("Plan and compare the notes", "m");
    const c = await post("Fail on purpose", "s");
    const d = await post("Plan another report", "m");
    await fetch(`${base}/__mock/heat?seconds=0.2`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 900));
    await fetch(`${base}/quests/${d.id}/stop`, { method: "POST" });
    let all = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const { quests } = await (await fetch(`${base}/quests`)).json();
      all = quests;
      if (quests.every((q) => q.status !== "queued" && q.status !== "running")) break;
    }
    const status = Object.fromEntries(all.map((q) => [q.id, q.status]));
    assert.equal(status[a.id], "done");
    assert.equal(status[b.id], "done");
    assert.equal(status[c.id], "failed");
    assert.equal(status[d.id], "stopped");
    // the ring replayed: every event the face and the views react to is there
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    let text = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 1500 && !/heat\.clear/.test(text)) text += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    ac.abort();
    for (const type of ["quest.phase", "agent.split", "brain.failed", "heat.cutoff", "heat.clear", "quest.done"]) assert.match(text, new RegExp(`"type":"${type.replace(".", "\\.")}"`), `the mock sends ${type}`);
    assert.match(text, /"phase":"judge"/);
  } finally {
    stop();
  }
});
