import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYS, canPause, cardHome, cardState, chronosHome, liteHome, defaultBackend, engineFile, platformOf, systemTar, unpackPlan } from "./platform.mjs";

test("the platform key is the system and the processor, and this machine has one", () => {
  assert.deepEqual(platformOf("linux", "x64"), { os: "linux", arch: "x64", key: "linux-x64" });
  assert.equal(platformOf("darwin", "arm64").key, "darwin-arm64");
  assert.equal(platformOf("win32", "x64").key, "win32-x64");
  assert.equal(platformOf().key, `${process.platform}-${process.arch}`);
  for (const k of ["linux-x64", "darwin-arm64", "win32-x64"]) assert.ok(KEYS.includes(k), k);
});

test("the Chronos home: CHRONOS_HOME, else ~/.chronos, else %LOCALAPPDATA%\\Chronos on Windows", () => {
  assert.equal(chronosHome({ env: { CHRONOS_HOME: "/tmp/x" }, platform: "win32", homedir: "C:\\Users\\me" }), "/tmp/x");
  assert.equal(chronosHome({ env: {}, platform: "linux", homedir: "/home/me" }), "/home/me/.chronos");
  assert.equal(chronosHome({ env: {}, platform: "darwin", homedir: "/Users/me" }), "/Users/me/.chronos");
  assert.equal(chronosHome({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32", homedir: "C:\\Users\\me" }), "C:\\Users\\me\\AppData\\Local\\Chronos");
  assert.equal(chronosHome({ env: {}, platform: "win32", homedir: "C:\\Users\\me" }), "C:\\Users\\me\\AppData\\Local\\Chronos", "no LOCALAPPDATA: the profile's own");
});

test("the engine's file name and whether a process can be paused, per system", () => {
  assert.equal(engineFile("linux"), "llama-server");
  assert.equal(engineFile("darwin"), "llama-server");
  assert.equal(engineFile("win32"), "llama-server.exe");
  assert.equal(canPause("linux"), true);
  assert.equal(canPause("darwin"), true);
  assert.equal(canPause("win32"), false);
  assert.equal(defaultBackend("darwin-arm64"), "metal");
  assert.equal(defaultBackend("darwin-x64"), "none", "the macOS x64 release is built with Metal off");
  assert.equal(defaultBackend("win32-x64"), "vulkan");
});

test("Windows unpacks with its own System32 tar when it is there", () => {
  const env = { SystemRoot: "C:\\Windows" };
  assert.equal(systemTar({ platform: "win32", env, exists: () => true }), "C:\\Windows\\System32\\tar.exe");
  assert.equal(systemTar({ platform: "win32", env, exists: () => false }), "tar");
  assert.equal(systemTar({ platform: "linux" }), "tar");
});

test("the unpack plan: tar for tar.gz, unzip then tar for a zip on Linux, tar for a zip elsewhere, a sentence when nothing can", () => {
  const gz = unpackPlan("tar.gz", "/h/bin/e.tar.gz", "/h/bin/x", { platform: "linux" });
  assert.deepEqual(gz.steps, [{ cmd: "tar", args: ["-xzf", "/h/bin/e.tar.gz", "-C", "/h/bin/x"] }]);
  const zipLinux = unpackPlan("zip", "/h/e.zip", "/h/x", { platform: "linux" });
  assert.deepEqual(zipLinux.steps.map((s) => s.cmd), ["unzip", "tar"]);
  const zipWin = unpackPlan("zip", "C:\\h\\e.zip", "C:\\h\\x", { platform: "win32", tar: "C:\\Windows\\System32\\tar.exe" });
  assert.deepEqual(zipWin.steps, [{ cmd: "C:\\Windows\\System32\\tar.exe", args: ["-xf", "C:\\h\\e.zip", "-C", "C:\\h\\x"] }]);
  const none = unpackPlan("zip", "/h/e.zip", "/h/x", { platform: "linux", have: { tar: false, unzip: false } });
  assert.deepEqual(none.steps, []);
  assert.match(none.why, /neither unzip nor tar is installed/);
  assert.match(unpackPlan("tar.gz", "/h/e.tar.gz", "/h/x", { platform: "darwin", have: { tar: false } }).why, /tar is not installed/);
  assert.match(unpackPlan("7z", "/h/e.7z", "/h/x").why, /no way to unpack/);
});

test("Lite keeps its own home, and the card lock stays in the full Chronos home", () => {
  assert.equal(liteHome({ env: {}, platform: "linux", homedir: "/h" }), "/h/.chronos-lite");
  assert.equal(liteHome({ env: {}, platform: "darwin", homedir: "/h" }), "/h/.chronos-lite");
  assert.equal(liteHome({ env: { CHRONOS_LITE_HOME: "/x" }, platform: "linux", homedir: "/h" }), "/x");
  assert.equal(liteHome({ env: { LOCALAPPDATA: "C:\\L" }, platform: "win32", homedir: "C:\\h" }), "C:\\L\\ChronosLite");
  // CHRONOS_LITE_HOME never moves the lock; CHRONOS_HOME does, as it does for full Chronos
  assert.equal(cardHome({ env: { CHRONOS_LITE_HOME: "/x" }, platform: "linux", homedir: "/h" }), "/h/.chronos");
  assert.equal(cardHome({ env: { CHRONOS_HOME: "/c" }, platform: "linux", homedir: "/h" }), "/c");
});

test("cardState judges the card lock by the lock's own rule: dead holder stale, live holder or engine held, another host never judged", () => {
  const alive = (pid) => [11, 22].includes(pid);
  const host = "here";
  assert.deepEqual(cardState(null, { alive, host }), { lock: null, state: "free", holder: null });
  // the shape a full Chronos left behind when it died: its pid and its engine both gone
  const dead = { pid: 38, port: 7777, brain: "qwen3.5-4b", host, what: "server.mjs", id: "38-x", engines: [39] };
  const s = cardState(dead, { alive, host });
  assert.equal(s.state, "stale");
  assert.match(s.holder, /qwen3\.5-4b of the Chronos on port 7777 \(pid 38\b/);
  assert.equal(cardState({ ...dead, pid: 11 }, { alive, host }).state, "held", "a live holder holds");
  assert.equal(cardState({ ...dead, engines: [22] }, { alive, host }).state, "held", "a dead runtime whose engine still runs holds");
  assert.equal(cardState({ ...dead, host: "elsewhere" }, { alive, host }).state, "held", "another host's lock is never judged from here");
  assert.equal(cardState({ ...dead, host: undefined }, { alive, host }).state, "stale", "an old lock with no host is judged here");
  assert.equal(cardState({ corrupt: true }, { alive, host }).state, "stale", "an unreadable lock holds nothing");
});
