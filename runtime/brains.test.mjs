import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { deviceOf, engineArgs, gpuControl, gpuLimitArgs, threadArgs, threadBudget, Brains, loadCatalogue, expandHome, parseDevices, pickGpuDevice } from "./brains.mjs";
import { readHardware } from "./hardware.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ID = "qwen3.5-0.8b";

function collectingBus() {
  const events = [];
  return { events, emit: (type, data) => events.push({ type, data }) };
}

function portOpen(port) {
  try {
    const out = execSync("ss -ltn", { encoding: "utf8" });
    return out.includes(`:${port} `);
  } catch {
    return false;
  }
}

test("loadCatalogue parses forge/brains.json and expands ~ in home", () => {
  const cat = loadCatalogue(ROOT);
  assert.equal(cat.version, 1);
  assert.equal(cat.brains.length, 3, "Lite has three brains");
  assert.deepEqual(cat.brains.map((b) => b.id).sort(), ["qwen3.5-0.8b", "qwen3.5-4b", "qwen3.5-9b"]);
  assert.equal(cat.alternates, undefined, "no alternates");
  assert.ok(cat.home.endsWith(".chronos-lite"), "Lite's own home");
  // ports a hundred above full Chronos's, so the two never meet
  assert.deepEqual(cat.brains.map((b) => b.port).sort(), [7710, 7720, 7730]);
  for (const b of cat.brains) assert.match(b.sha256, /^[0-9a-f]{64}$/, `${b.id} is pinned`);
  assert.ok(!cat.home.startsWith("~"), "home expanded");
  assert.ok(cat.home.startsWith(os.homedir()));
  assert.equal(cat.slots.offspring, LIVE_ID);
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandHome("/abs"), "/abs");
});

test("list() marks present files and idle status", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-home-"));
  try {
    mkdirSync(path.join(home, "models"), { recursive: true });
    const cat = loadCatalogue(ROOT);
    const tiny = cat.brains.find((b) => b.id === LIVE_ID);
    writeFileSync(path.join(home, "models", tiny.file), "not a real gguf");
    const brains = new Brains({ root: ROOT, home, bus: collectingBus() });
    const list = brains.list();
    assert.equal(list.length, cat.brains.length);
    assert.deepEqual(list.map((b) => b.id), cat.brains.map((b) => b.id));
    const mine = list.find((b) => b.id === LIVE_ID);
    assert.equal(mine.present, true);
    assert.equal(mine.status, "idle");
    assert.equal(mine.slot, "offspring");
    assert.equal(mine.port, 7730);
    assert.equal(mine.pid, null);
    assert.equal(mine.tokensPerSecond, null);
    for (const b of list) if (b.id !== LIVE_ID) assert.equal(b.present, false, `${b.id} absent`);
    assert.equal(brains.urlOf(LIVE_ID), "http://127.0.0.1:7730");
    assert.throws(() => brains.brainOf("nope"), /No brain "nope"/);
    brains.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("start refuses a brain that is not downloaded, and switchSlot a brain that will not fit", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-home-"));
  try {
    const bus = collectingBus();
    const brains = new Brains({ root: ROOT, home, bus });
    await assert.rejects(brains.start("qwen3.5-9b"), /not downloaded/);
    assert.equal(bus.events.length, 0, "nothing emitted on refusal");
    // A brain whose file is there but whose VRAM ask is absurd: fits says no, nothing changes.
    mkdirSync(path.join(home, "models"), { recursive: true });
    const big = brains.brainOf("qwen3.5-9b");
    writeFileSync(path.join(home, "models", big.file), "fake");
    big.vramMiB = 100000;
    big.ramMiB = 100000;
    big.device = "cpu";
    await assert.rejects(brains.switchSlot("talk", "qwen3.5-9b"), /Cannot switch "talk"/);
    assert.equal(brains.slots.talk, "qwen3.5-9b", "slot unchanged");
    assert.equal(brains.list().find((b) => b.id === "qwen3.5-9b").status, "idle");
    await assert.rejects(brains.switchSlot("nope", LIVE_ID), /No slot "nope"/);
    brains.dispose();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const liveHome = process.env.CHRONOS_LITE_HOME ?? loadCatalogue(ROOT).home;
const liveBrain = loadCatalogue(ROOT).brains.find((b) => b.id === LIVE_ID);
const liveModel = path.join(liveHome, "models", liveBrain.file);
const liveEngine = path.join(liveHome, "bin", "llama", "llama-server");
const canRunLive = existsSync(liveModel) && existsSync(liveEngine);
const liveOptIn = process.env.CHRONOS_LIVE_TESTS === "1";

test("live: start the 0.8B brain, ask it to say hi, stop it", { skip: !liveOptIn ? "set CHRONOS_LIVE_TESTS=1 to start a real model server" : (!canRunLive && "the 0.8B model or the engine is missing"), timeout: 240_000 }, async () => {
  assert.equal(portOpen(liveBrain.port), false, `port ${liveBrain.port} must be free before the test`);
  const bus = collectingBus();
  const brains = new Brains({ root: ROOT, home: liveHome, bus });
  const vramBefore = readHardware().vram.usedMiB;
  try {
    const started = await brains.start(LIVE_ID);
    const vramDuring = readHardware().vram.usedMiB;
    console.log(`live VRAM used: ${vramBefore} MiB before, ${vramDuring} MiB with the brain loaded`);
    // The catalogue puts the Offspring on the CPU: the model must stay off the GPU.
    // (A brain on the GPU would take hundreds of MiB here.)
    const onCpu = brains.list().find((b) => b.id === LIVE_ID).device === "cpu";
    if (vramBefore > 0 || vramDuring > 0) {
      if (onCpu) assert.ok(vramDuring - vramBefore < 200, `a CPU brain left the GPU alone (${vramDuring - vramBefore} MiB)`);
      else assert.ok(vramDuring - vramBefore > 400, "the model took VRAM on the GPU");
    }
    assert.ok(started.pid > 0);
    assert.equal(brains.list().find((b) => b.id === LIVE_ID).status, "ready");
    assert.deepEqual(bus.events.map((e) => e.type), ["brain.loading", "brain.ready"]);

    const answer = await brains.chat(LIVE_ID, [{ role: "user", content: "Say hi in three words" }], { maxTokens: 32 });
    console.log(`live answer: ${JSON.stringify(answer.content)} at ${answer.tokensPerSecond} tokens/s`);
    assert.ok(answer.content.trim().length > 0, "non-empty answer");
    assert.ok(answer.tokensPerSecond > 0);
    assert.ok(answer.usage.completion_tokens > 0);
    assert.deepEqual(answer.toolCalls, []);
    assert.equal(brains.list().find((b) => b.id === LIVE_ID).tokensPerSecond > 0, true);

    const log = readFileSync(brains.logPath(LIVE_ID), "utf8");
    assert.match(log, /offloaded \d+\/\d+ layers to GPU/, "layers went to the GPU");
  } finally {
    await brains.stop(LIVE_ID);
    brains.dispose();
  }
  assert.equal(bus.events.at(-1).type, "brain.stopped");
  assert.equal(brains.list().find((b) => b.id === LIVE_ID).status, "idle");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(portOpen(liveBrain.port), false, "server gone after stop");
});

test("engineArgs drops what the launch line sets and keeps the catalogue's own flags", () => {
  const common = ["-ngl", "99", "--jinja", "--no-webui", "--host", "127.0.0.1", "--cache-ram", "1024", "-fa", "on"];
  assert.deepEqual(engineArgs(common), ["--cache-ram", "1024", "-fa", "on"]);
  assert.deepEqual(engineArgs(["--no-warmup", "-c", "4096", "-np", "2", "--cache-reuse", "256"]), ["--cache-reuse", "256"]);
  assert.deepEqual(engineArgs(), []);
});

test("deviceOf: CHRONOS_DEVICE wins, then engine.device, then the brain's own", () => {
  const gpu = { id: "a" };
  const cpu = { id: "b", device: "cpu" };
  assert.equal(deviceOf(gpu, {}, {}), "gpu");
  assert.equal(deviceOf(cpu, {}, {}), "cpu");
  assert.equal(deviceOf(gpu, { device: "cpu" }, {}), "cpu", "the catalogue can put every brain on the CPU");
  assert.equal(deviceOf(gpu, { device: "auto" }, {}), "gpu");
  assert.equal(deviceOf(gpu, { device: "cpu" }, { CHRONOS_DEVICE: "auto" }), "gpu", "the environment wins");
  assert.equal(deviceOf(cpu, { device: "auto" }, { CHRONOS_DEVICE: "auto" }), "cpu", "auto never moves a CPU brain to the GPU");
});

test("gpuControl does nothing without the helper, and calls sudo -n with the mode when it is there", async () => {
  assert.deepEqual(await gpuControl("cap", { helper: "/nonexistent/chronos-gpu" }), { ok: false, out: "the GPU helper is not installed" });
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, "capped: 0: 300Mhz 1: 500Mhz", ""); };
  // any file that exists stands in for the helper (run is the test's): this Node, on every system
  const helper = process.execPath;
  const out = await gpuControl("cap", { helper, run });
  assert.deepEqual(out, { ok: true, out: "capped: 0: 300Mhz 1: 500Mhz" });
  assert.deepEqual(calls, [["sudo", "-n", helper, "cap"]]);
  const fail = await gpuControl("auto", { helper, run: (c, a, o, cb) => cb(new Error("x"), "", "sudo: a password is required") });
  assert.deepEqual(fail, { ok: false, out: "sudo: a password is required" });
});

test("the owner keeps 20% of the threads: CPU brains share the rest, a GPU brain needs two", () => {
  assert.equal(threadBudget(16, 0.2), 12);
  assert.equal(threadBudget(8, 0.2), 6);
  assert.equal(threadBudget(1, 0.2), 1);
  assert.deepEqual(threadArgs({ threads: 8 }, false, 12), ["-t", "8", "-tb", "8"]);
  assert.deepEqual(threadArgs({ threads: 40 }, false, 12), ["-t", "12", "-tb", "12"], "never above the budget");
  assert.deepEqual(threadArgs({}, false, 12), ["-t", "12", "-tb", "12"]);
  assert.deepEqual(threadArgs({ threads: 8 }, true, 12), ["-t", "2"]);
});

test("a governed GPU brain shrinks only the physical batch, so speculative drafts still fit", () => {
  const src = readFileSync(new URL("./brains.mjs", import.meta.url), "utf8");
  assert.ok(!/"-b", "16"/.test(src), "the logical batch is never shrunk");
  assert.match(src, /"-ub", String\(brain\.ub \?\? 8\)/);
});

test("gpuControl passes a mode with its arguments to the helper", async () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, "limited to 1400 MHz, offset 0 mV", ""); };
  const out = await gpuControl(["limit", 1400, 0], { helper: process.execPath, run });
  assert.deepEqual(out, { ok: true, out: "limited to 1400 MHz, offset 0 mV" });
  assert.deepEqual(calls, [["sudo", "-n", process.execPath, "limit", "1400", "0"]]);
});

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test("a json_schema chat asks for the parsed reasoning format, so the grammar starts after an empty thinking block", async () => {
  // a stand-in llama-server that records what it was sent
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"score":0.9,"verdict":"pass","note":"ok"}' } }], usage: { prompt_tokens: 5, completion_tokens: 9 }, timings: { predicted_per_second: 21 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const brains = new Brains({ root: ROOT, home: mkdtempSync(path.join(os.tmpdir(), "chronos-rf-")), bus: collectingBus(), readJunction: () => NaN });
  try {
    brains.state.get(LIVE_ID).port = server.address().port;
    brains.brainOf(LIVE_ID).port = server.address().port;
    const schema = { name: "judgement", schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } };
    const judged = await brains.chat(LIVE_ID, [{ role: "user", content: "judge it" }], { json_schema: schema, thinking: false });
    assert.equal(seen[0].reasoning_format, "auto", "the workers run with --reasoning-format none; a grammar needs the parsed format");
    assert.equal(seen[0].response_format.json_schema.name, "judgement");
    assert.equal(seen[0].chat_template_kwargs.enable_thinking, false);
    assert.ok(String(judged.content).includes('"score"'));

    await brains.chat(LIVE_ID, [{ role: "user", content: "say hi" }], {});
    assert.equal(seen[1].reasoning_format, undefined, "a plain chat is sent as before");
    assert.equal(seen[1].response_format, undefined);
  } finally {
    brains.dispose();
    await new Promise((r) => server.close(r));
  }
});

test("a GPU start waits for a cooling card but not for one that rests warm: it loads once the junction has stopped falling", async () => {
  const bus = collectingBus();
  const said = () => bus.events.filter((e) => e.type === "log").map((e) => e.data.text);

  // the card rests at 80 C and never falls: the wait ends after restMs, long before startWaitMs
  let brains = new Brains({ root: ROOT, home: os.tmpdir(), bus, readJunction: () => 80, startWaitMs: 5000, restMs: 60 });
  let t = Date.now();
  await brains._coolForStart(74, "qwen3.5-4b");
  assert.ok(Date.now() - t < 1500, "a card that is not falling is not waited for");
  assert.ok(said().some((s) => /rests at 80 C and is not falling/.test(s)));
  brains.dispose();

  // a card that is falling is waited for until it is under the mark
  let j = 86;
  brains = new Brains({ root: ROOT, home: os.tmpdir(), bus: collectingBus(), readJunction: () => (j -= 3), startWaitMs: 5000, restMs: 200 });
  await brains._coolForStart(74, "qwen3.5-4b");
  assert.ok(j < 74, "it waited until the junction was under the mark");
  brains.dispose();

  // a cool card is not waited for at all, and no reading is no wait
  brains = new Brains({ root: ROOT, home: os.tmpdir(), bus: collectingBus(), readJunction: () => 60, startWaitMs: 5000, restMs: 200 });
  t = Date.now();
  await brains._coolForStart(74, "qwen3.5-4b");
  assert.ok(Date.now() - t < 100);
  brains.dispose();
  brains = new Brains({ root: ROOT, home: os.tmpdir(), bus: collectingBus(), readJunction: () => NaN, startWaitMs: 5000, restMs: 200 });
  await brains._coolForStart(74, "qwen3.5-4b");
  brains.dispose();

  // the cap still holds: a card that keeps inching down is given startWaitMs and no more
  let k = 200;
  brains = new Brains({ root: ROOT, home: os.tmpdir(), bus: collectingBus(), readJunction: () => (k -= 0.01), startWaitMs: 300, restMs: 10_000 });
  t = Date.now();
  await brains._coolForStart(74, "qwen3.5-4b");
  assert.ok(Date.now() - t >= 280 && Date.now() - t < 3000);
  brains.dispose();
});

const NOV = `Available devices:
  Vulkan0: AMD Radeon RX 6800M (RADV NAVI22) (12272 MiB, 11533 MiB free)
  Vulkan1: AMD Radeon Graphics (RADV RENOIR) (16255 MiB, 14985 MiB free)
`;
const OCT = `Available devices:
  Vulkan0: AMD Radeon Graphics (RADV RENOIR) (16255 MiB, 14985 MiB free)
  Vulkan1: AMD Radeon RX 6800M (RADV NAVI22) (12272 MiB, 11533 MiB free)
`;

test("the card GPU brains go to is picked from the engine's own list, whatever order it comes in", async () => {
  assert.deepEqual(parseDevices(NOV), [
    { index: 0, name: "AMD Radeon RX 6800M (RADV NAVI22)", totalMiB: 12272, freeMiB: 11533 },
    { index: 1, name: "AMD Radeon Graphics (RADV RENOIR)", totalMiB: 16255, freeMiB: 14985 },
  ]);
  assert.deepEqual(parseDevices("no devices here"), []);

  // the same laptop, before and after its device order flipped: the RX 6800M either way
  assert.equal(pickGpuDevice(parseDevices(NOV), { vramTotalMiB: 12272 }).index, 0);
  assert.equal(pickGpuDevice(parseDevices(OCT), { vramTotalMiB: 12272 }).index, 1);
  // without a reading from the hardware sense, the integrated chip is still passed over, though it has more memory
  assert.equal(pickGpuDevice(parseDevices(NOV)).index, 0);
  assert.equal(pickGpuDevice(parseDevices(OCT)).index, 1);
  assert.match(pickGpuDevice(parseDevices(OCT)).why, /not integrated/);
  // a machine with only integrated graphics gets the one it has; none listed is null
  assert.equal(pickGpuDevice(parseDevices("  Vulkan0: Intel(R) UHD Graphics 770 (ADL-S GT1) (15900 MiB, 15000 MiB free)\n")).index, 0);
  assert.equal(pickGpuDevice([]), null);
  // two cards that are not integrated: the one whose memory the hardware sense reads
  const two = parseDevices("  Vulkan0: NVIDIA GeForce RTX 4060 (8188 MiB, 8000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4090 (24564 MiB, 24000 MiB free)\n");
  assert.equal(pickGpuDevice(two, { vramTotalMiB: 24564 }).index, 1);

  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-gpu-"));
  const bus = collectingBus();
  let asked = 0;
  // the Vulkan pick is Linux's and Windows' (on macOS Metal has one GPU and nothing is asked), so the test says linux
  const brains = new Brains({ root: ROOT, home, bus, platform: "linux", hasCard: true, readJunction: () => NaN, listDevices: () => (asked++, OCT), vramTotalMiB: () => 12272 });
  assert.equal(await brains._gpuIndex(), "1");
  assert.equal(await brains._gpuIndex(), "1");
  assert.equal(asked, 1, "the engine is asked once");
  assert.ok(bus.events.some((e) => e.type === "log" && /GPU brains go to Vulkan1, AMD Radeon RX 6800M/.test(e.data.text) && /left alone: Vulkan0 AMD Radeon Graphics/.test(e.data.text)));
  brains.dispose();

  // an explicit pin wins and the engine is never asked
  const pinned = new Brains({ root: ROOT, home, bus: collectingBus(), platform: "linux", hasCard: true, readJunction: () => NaN, gpuDevice: "3", listDevices: () => { throw new Error("not asked"); } });
  assert.equal(await pinned._gpuIndex(), "3");
  pinned.dispose();

  // an engine that lists nothing: device 0, and the log says it is a guess
  const blind = collectingBus();
  const guess = new Brains({ root: ROOT, home, bus: blind, platform: "linux", hasCard: true, readJunction: () => NaN, listDevices: () => "", vramTotalMiB: () => 0 });
  assert.equal(await guess._gpuIndex(), "0");
  assert.ok(blind.events.some((e) => /a guess/.test(e.data.text)));
  guess.dispose();
});

test("the wrong-GPU check reads the last start in an appended log, not an older one", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-devlog-"));
  const bus = collectingBus();
  const brains = new Brains({ root: ROOT, home, bus, readJunction: () => NaN, listDevices: () => NOV, vramTotalMiB: () => 12272 });
  brains.gpuPick = { index: 0, name: "AMD Radeon RX 6800M (RADV NAVI22)", why: "test" };
  mkdirSync(path.dirname(brains.logPath(LIVE_ID)), { recursive: true });
  const line = (name) => `0.01.0 I llama_prepare_model_devices: using device Vulkan0 (${name}) (0000:03:00.0) - 11533 MiB free\n`;
  // an older start went to the integrated chip; this start went to the card: no alarm
  writeFileSync(brains.logPath(LIVE_ID), line("AMD Radeon Graphics (RADV RENOIR)") + "...\n" + line("AMD Radeon RX 6800M (RADV NAVI22)"));
  brains._checkDevice(LIVE_ID);
  assert.equal(bus.events.filter((e) => /wrong GPU/.test(e.data?.text ?? "")).length, 0);
  // this start went to the integrated chip: said loudly
  writeFileSync(brains.logPath(LIVE_ID), line("AMD Radeon RX 6800M (RADV NAVI22)") + line("AMD Radeon Graphics (RADV RENOIR)"));
  brains._checkDevice(LIVE_ID);
  assert.ok(bus.events.some((e) => e.data?.level === "error" && /loaded on AMD Radeon Graphics \(RADV RENOIR\), not on AMD Radeon RX 6800M/.test(e.data.text)));
  brains.dispose();
});

/** stands in for llama-server: answers /health with ok on its --port and nothing else; it loads no model and touches no card */
const FAKE_ENGINE = `#!${process.execPath}
const http = require("node:http");
const args = process.argv.slice(2);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
}).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`;

test("a GPU brain's start runs the catalogue's gpuLimit when it asks for a clock or a voltage offset, and not when it asks for neither", { skip: process.platform === "win32" ? "the stand-in engine is a script with a #! line" : (process.env.CHRONOS_DEVICE === "cpu" && "CHRONOS_DEVICE=cpu puts every brain on the CPU"), timeout: 60_000 }, async () => {
  assert.deepEqual(gpuLimitArgs({ mhz: 0, mv: -50 }), ["limit", "0", "-50"], "the catalogue's own: leave the clock, undervolt 50 mV");
  assert.deepEqual(gpuLimitArgs({ mhz: 1800 }), ["limit", "1800", "0"]);
  assert.deepEqual(gpuLimitArgs({ mhz: 1800, mv: -25 }), ["limit", "1800", "-25"]);
  assert.deepEqual(gpuLimitArgs({ mv: -50 }), ["limit", "0", "-50"]);
  assert.equal(gpuLimitArgs({ mhz: 0, mv: 0 }), null);
  assert.equal(gpuLimitArgs({}), null);
  assert.equal(gpuLimitArgs(undefined), null);
  // Lite's catalogue asks for no limit: the root helper stays with full Chronos and Lite runs under the governor alone
  assert.equal(gpuLimitArgs(loadCatalogue(ROOT).engine.gpuLimit), null);

  const id = "qwen3.5-4b";
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-limit-"));
  const bus = collectingBus();
  const gpuCalls = [];
  let answer = { ok: true, out: "limited: offset -50 mV" };
  // no junction to read: no wait for a cool card and no governor; the helper is the test's own, so the card is never touched
  const brains = new Brains({ root: ROOT, home, bus, readJunction: () => NaN, hasCard: true, listDevices: () => NOV, vramTotalMiB: () => 12272, gpu: async (m) => { gpuCalls.push(m); return answer; } });
  try {
    const brain = brains.brainOf(id);
    assert.equal(deviceOf(brain, brains.catalogue.engine), "gpu");
    brain.port = await freePort();
    brain.vramMiB = 0; // the stand-in needs no memory, whatever the real card holds right now
    mkdirSync(path.join(home, "models"), { recursive: true });
    writeFileSync(path.join(home, "models", brain.file), "not a real gguf");
    mkdirSync(path.join(home, "bin", "llama"), { recursive: true });
    writeFileSync(brains.engine, FAKE_ENGINE);
    chmodSync(brains.engine, 0o755);
    const said = () => bus.events.filter((e) => e.type === "log").map((e) => e.data.text);
    const cycle = async (gpuLimit) => {
      gpuCalls.length = 0;
      if (gpuLimit === undefined) delete brains.catalogue.engine.gpuLimit;
      else brains.catalogue.engine.gpuLimit = gpuLimit;
      await brains.start(id);
      const atStart = [...gpuCalls];
      await brains.stop(id);
      return atStart;
    };

    // the clock left alone and 50 mV less: the helper is called, where a guard on mhz alone skipped it
    assert.deepEqual(await cycle({ mhz: 0, mv: -50 }), [["limit", "0", "-50"]]);
    assert.ok(said().includes(`GPU limited for ${id}: limited: offset -50 mV`));
    assert.deepEqual(gpuCalls.at(-1), "auto", "the last GPU brain's stop gives the card back, which takes the offset off again");

    // a clock ceiling alone still works as before
    assert.deepEqual(await cycle({ mhz: 1800 }), [["limit", "1800", "0"]]);

    // no limit asked, or both zero: the helper is not called at the start
    assert.deepEqual(await cycle(undefined), []);
    assert.deepEqual(await cycle({ mhz: 0, mv: 0 }), []);

    // a helper that cannot (overdrive off, not installed): the brain still starts and the log says the limit is not on
    answer = { ok: false, out: "overdrive is off: run install-gpu-control.sh --overdrive and reboot" };
    assert.deepEqual(await cycle({ mhz: 0, mv: -50 }), [["limit", "0", "-50"]]);
    assert.ok(said().some((t) => /^GPU limit not applied \(overdrive is off/.test(t) && /the governor alone holds the heat$/.test(t)));
  } finally {
    await brains.stopAll().catch(() => {});
    brains.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test("per system: the engine's file name, the governor only where it can run, and the CPU for every brain when there is no card", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-sys-"));
  const made = [];
  const make = (opts) => {
    const b = new Brains({ root: ROOT, home, bus: collectingBus(), ...opts });
    made.push(b);
    return b;
  };
  try {
    // Linux with the amdgpu junction: governed, llama-server
    const linux = make({ platform: "linux", readJunction: () => 71, hasCard: true });
    assert.equal(linux.engine, path.join(home, "bin", "llama", "llama-server"));
    assert.deepEqual(linux.governorStatus(), { runs: true, why: null });
    assert.equal(linux.governed, true);
    assert.equal(linux.list().find((b) => b.id === "qwen3.5-4b").device, "gpu");

    // Linux with a card but no junction to read (an NVIDIA card): ungoverned, and it says why
    const blind = make({ platform: "linux", readJunction: () => null, hasCard: true });
    assert.equal(blind.governed, false);
    assert.match(blind.governorStatus().why, /no GPU junction temperature can be read/);
    assert.equal(blind.governing, false, "the heat watchdog has no governor to defer to");

    // Windows: llama-server.exe, never governed (nothing there pauses a process), even with a temperature
    const win = make({ platform: "win32", readJunction: () => 71, hasCard: true });
    assert.ok(win.engine.endsWith("llama-server.exe"));
    assert.equal(win.governed, false);
    assert.match(win.governorStatus().why, /cannot pause a process/);

    // macOS: no junction, so ungoverned; llama-server
    const mac = make({ platform: "darwin", readJunction: () => null, hasCard: true });
    assert.ok(mac.engine.endsWith(`${path.sep}llama-server`));
    assert.equal(mac.governed, false);

    // no card to fill: every brain is a CPU brain, as with the catalogue's engine.device "cpu"
    const bare = make({ platform: "linux", readJunction: () => null, hasCard: false });
    assert.ok(bare.list().filter((b) => !b.alternate).every((b) => b.device === "cpu"), "every brain on the CPU");
    assert.equal(bare.noCard, true);
    assert.equal(make({ platform: "linux", readJunction: () => 71, hasCard: () => true }).noCard, undefined);
  } finally {
    for (const b of made) b.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

/** stands in for llama-server like FAKE_ENGINE, and writes the arguments it was started with beside itself */
const ARGV_ENGINE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify(args));
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
}).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`;

test("a vision brain starts with its projector when it is on disk (on the CPU unless the catalogue says mmprojOnGpu), and says it can see", { skip: process.platform === "win32" ? "the stand-in engine is a script with a #! line" : false, timeout: 60_000 }, async () => {
  const id = "qwen3.5-9b";
  const home = mkdtempSync(path.join(os.tmpdir(), "chronos-sight-"));
  const saved = process.env.CHRONOS_DEVICE;
  // every brain on the CPU: the card is never asked for, and no lock is taken
  process.env.CHRONOS_DEVICE = "cpu";
  const brains = new Brains({ root: ROOT, home, bus: collectingBus(), readJunction: () => NaN, hasCard: false });
  try {
    const brain = brains.brainOf(id);
    assert.equal(brain.vision, true);
    assert.equal(brain.mmproj, "mmproj-F16.gguf");
    brain.port = await freePort();
    brain.vramMiB = 0;
    brain.ramMiB = 0;
    mkdirSync(path.join(home, "models"), { recursive: true });
    writeFileSync(path.join(home, "models", brain.file), "not a real gguf");
    mkdirSync(path.join(home, "bin", "llama"), { recursive: true });
    writeFileSync(brains.engine, ARGV_ENGINE);
    chmodSync(brains.engine, 0o755);
    const argv = () => JSON.parse(readFileSync(path.join(path.dirname(brains.engine), "argv.json"), "utf8"));
    const row = () => brains.list().find((b) => b.id === id);

    // no projector on disk: blind, and told not to fetch one by itself
    assert.equal(row().vision, false);
    assert.deepEqual(row().mmproj, { file: "mmproj-F16.gguf", present: false });
    await brains.start(id);
    assert.ok(argv().includes("--no-mmproj"));
    assert.ok(!argv().includes("--mmproj"));
    assert.equal(row().vision, false);
    await brains.stop(id);

    // the projector on disk: loaded, on the CPU
    writeFileSync(path.join(home, "models", "mmproj-F16.gguf"), "not a real projector");
    assert.equal(row().vision, true, "at rest, it would see");
    await brains.start(id);
    const a = argv();
    assert.equal(a[a.indexOf("--mmproj") + 1], path.join(home, "models", "mmproj-F16.gguf"));
    assert.ok(a.includes("--no-mmproj-offload"));
    assert.equal(row().vision, true);
    await brains.stop(id);

    // a blind brain gets neither flag
    const small = brains.brainOf("qwen3.5-0.8b");
    small.port = await freePort();
    small.vramMiB = 0;
    small.ramMiB = 0;
    writeFileSync(path.join(home, "models", small.file), "not a real gguf");
    await brains.start("qwen3.5-0.8b");
    assert.ok(!argv().some((x) => /mmproj/.test(x)));
    assert.equal(brains.list().find((b) => b.id === "qwen3.5-0.8b").vision, false);
  } finally {
    await brains.stopAll().catch(() => {});
    brains.dispose();
    if (saved === undefined) delete process.env.CHRONOS_DEVICE;
    else process.env.CHRONOS_DEVICE = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the card lock lives in the full Chronos home when the caller names it, or names no home; a test's own home keeps it", () => {
  const lite = mkdtempSync(path.join(os.tmpdir(), "chronos-lite-home-"));
  const full = mkdtempSync(path.join(os.tmpdir(), "chronos-full-home-"));
  const saved = process.env.CHRONOS_HOME;
  process.env.CHRONOS_HOME = full;
  try {
    // main() names both: brains under Lite's home, the lock under the full Chronos home
    const named = new Brains({ root: ROOT, home: lite, cardHome: full, bus: collectingBus(), readJunction: () => NaN });
    assert.equal(named.home, lite);
    assert.equal(named.card.file, path.join(full, "run", "gpu.lock"));
    named.dispose();
    // no home at all: the lock still goes to the full Chronos home (CHRONOS_HOME here)
    const bare = new Brains({ root: ROOT, bus: collectingBus(), readJunction: () => NaN });
    assert.equal(bare.card.file, path.join(full, "run", "gpu.lock"));
    bare.dispose();
    // only a home (a test): the lock stays inside it, so no test ever touches a real lock
    const own = new Brains({ root: ROOT, home: lite, bus: collectingBus(), readJunction: () => NaN });
    assert.equal(own.card.file, path.join(lite, "run", "gpu.lock"));
    own.dispose();
  } finally {
    if (saved === undefined) delete process.env.CHRONOS_HOME;
    else process.env.CHRONOS_HOME = saved;
    rmSync(lite, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  }
});
