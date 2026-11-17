// The facts that differ from one system to another, in one place: where the
// Chronos Lite home and the shared card lock's home are, what the engine's file is called, which release asset is
// this machine's, whether a process can be paused, and which tools unpack an
// archive. Everything here is pure or reads only the environment, so the
// tests can ask for any system from any system (cardState asks whether a pid is
// alive, and takes the probe as an argument for the tests).

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeHolder, pidAlive } from "./cardlock.mjs";

/** the platform keys llama.cpp publishes a release build for (forge/brains.json engine.assets) */
export const KEYS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"];

/** { os, arch, key } for this machine, or for the one named */
export function platformOf(platform = process.platform, arch = process.arch) {
  return { os: platform, arch, key: `${platform}-${arch}` };
}

/**
 * The Chronos home: CHRONOS_HOME when set, else %LOCALAPPDATA%\Chronos on
 * Windows (the profile's AppData\Local when the variable is missing) and
 * ~/.chronos everywhere else.
 */
export function chronosHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.CHRONOS_HOME) return env.CHRONOS_HOME;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local"), "Chronos");
  return path.posix.join(homedir, ".chronos");
}

/**
 * Chronos Lite's own home, picked the way chronosHome() picks the full one:
 * CHRONOS_LITE_HOME when set, else %LOCALAPPDATA%\ChronosLite on Windows and
 * ~/.chronos-lite everywhere else. Its engine, brains, logs and runs live here.
 */
export function liteHome({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.CHRONOS_LITE_HOME) return env.CHRONOS_LITE_HOME;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local"), "ChronosLite");
  return path.posix.join(homedir, ".chronos-lite");
}

/**
 * Where the card lock lives: the full Chronos home (chronosHome), never Lite's
 * own, so every Chronos on this computer, full or Lite, reads one
 * run/gpu.lock and two of them never share the GPU (docs/decisions/0009).
 */
export function cardHome(opts = {}) {
  return chronosHome(opts);
}

/** the engine's server binary: llama-server, llama-server.exe on Windows */
export function engineFile(platform = process.platform) {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

/**
 * Can a running process be paused and resumed (SIGSTOP / SIGCONT)? On Linux
 * and macOS yes; Windows has no such signal and Node's process.kill there
 * only terminates, so the governor never runs on it.
 */
export function canPause(platform = process.platform) {
  return platform !== "win32";
}

/**
 * The tar that reads zip on Windows is the system's own bsdtar
 * (%SystemRoot%\System32\tar.exe, Windows 10 1803 and later). A GNU tar from
 * Git or MSYS earlier on the PATH reads no zip and takes "C:" for a remote
 * host, so the system one is named outright when it is there.
 */
export function systemTar({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return "tar";
  const own = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
  return exists(own) ? own : "tar";
}

/**
 * How an archive is unpacked here: [{ cmd, args }] to try in order, given the
 * archive, the folder it goes into and which tools exist ({ tar, unzip }).
 * tar.gz: tar everywhere. zip: tar on macOS and Windows (bsdtar reads zip),
 * unzip on Linux (GNU tar does not), then tar as a last try. Returns
 * { steps, why } with why a plain sentence when nothing here can do it.
 */
export function unpackPlan(format, archive, dir, { platform = process.platform, have = { tar: true, unzip: true }, tar = systemTar({ platform }) } = {}) {
  const viaTar = { cmd: tar, args: [format === "zip" ? "-xf" : "-xzf", archive, "-C", dir] };
  const viaUnzip = { cmd: "unzip", args: ["-q", "-o", archive, "-d", dir] };
  let steps;
  if (format === "tar.gz") steps = have.tar ? [viaTar] : [];
  else if (format === "zip") steps = platform === "linux" ? [...(have.unzip ? [viaUnzip] : []), ...(have.tar ? [viaTar] : [])] : have.tar ? [viaTar] : [];
  else return { steps: [], why: `no way to unpack a "${format}" archive` };
  if (steps.length) return { steps, why: null };
  const need = format === "zip" && platform === "linux" ? "neither unzip nor tar is installed (sudo apt install unzip, or your system's package for it)" : "tar is not installed or not on the PATH";
  return { steps: [], why: `cannot unpack ${path.basename(archive)}: ${need}; it is kept at ${archive}, unpack it into ${dir} by hand` };
}

/** the GPU backend the release build for this key runs on, when the catalogue does not say */
export function defaultBackend(key) {
  if (key === "darwin-arm64") return "metal";
  if (key === "darwin-x64") return "none";
  return "vulkan";
}

/**
 * The card lock in words, judged by the card lock's own rule (runtime/cardlock.mjs): a lock from this host is stale
 * when neither its process nor any of its engines is alive, and a lock that cannot be read holds nothing; either is
 * taken over at Lite's first GPU start. A lock from another host is never judged from here.
 */
export function cardState(lock, { alive = pidAlive, host = os.hostname() } = {}) {
  if (!lock) return { lock: null, state: "free", holder: null };
  if (lock.corrupt) return { lock, state: "stale", holder: describeHolder(lock, { alive }) };
  const live = (lock.host && lock.host !== host) || alive(lock.pid) || (lock.engines ?? []).some((p) => alive(p));
  return { lock, state: live ? "held" : "stale", holder: describeHolder(lock, { alive }) };
}
