import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYS, canPause, cardHome, chronosHome, liteHome, defaultBackend, engineFile, platformOf, systemTar, unpackPlan } from "./platform.mjs";

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
