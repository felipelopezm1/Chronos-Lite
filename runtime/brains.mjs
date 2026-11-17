// The brains: one llama-server per resident model, started, stopped and
// switched per forge/brains.json, and refused when the hardware sense says
// the model will not fit.
//
// A brain marked "exclusive": true in the catalogue is alone on the GPU:
// starting it stops every other GPU brain first (the CPU brains stay), and
// starting any other GPU brain while it is up stops it first. GPU starts take
// turns, so two of them never decide at the same moment.
//
// Chronos Lite serves every brain with llama-server; full Chronos's second
// engine (Colibri) is cut. Alternates with a port and a file start by id too,
// outside the slots and list().
//
// The card is shared by every Chronos on this computer, full or Lite, not only
// by the brains of one runtime: before a GPU brain starts, this process takes
// the card lock (runtime/cardlock.mjs, run/gpu.lock under the full Chronos
// home, not Lite's own: platform.mjs cardHome, docs/decisions/0009). While another runtime or a
// probe holds it, the start waits (status "waiting", one brain.waiting event
// that names the holder) and then fails; it never moves to the CPU on its own.
// The lock goes when the last GPU brain of this process stops or exits, and
// when the process exits. CPU brains never touch it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHardware, fits, RESERVE } from "./hardware.mjs";
import { createGovernor, governorCan, junctionReader } from "./throttle.mjs";
import { cardHome, chronosHome, engineFile, liteHome } from "./platform.mjs";
import { filesOf, readRecord, resolveEngineDir, resolveFile, RECORD } from "./models.mjs";
import { execFile } from "node:child_process";
import { sseData, thinkSplitter } from "./stream.mjs";
import { postJson } from "./post.mjs";
import { createCardLock, CARD_POLL_MS, cardWaitMs, pidAlive } from "./cardlock.mjs";

const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;
const STOP_GRACE_MS = 5_000;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// "~" and "~/x" become the home directory.
export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Read forge/brains.json under root; its home comes back with "~" expanded.
export function loadCatalogue(root = PROJECT_ROOT) {
  const file = path.join(root, "forge", "brains.json");
  const catalogue = JSON.parse(readFileSync(file, "utf8"));
  catalogue.home = expandHome(catalogue.home ?? "~/.chronos-lite");
  return catalogue;
}

// A bus that goes nowhere, for callers that bring none.
const quietBus = { emit() {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /health; "ok" once the model is loaded, "loading" while it loads,
// "down" when nothing answers on the port. `at` is the full health URL when it
// is not <url>/health.
async function health(url, at = `${url}/health`) {
  try {
    const res = await fetch(at, { signal: AbortSignal.timeout(2000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.status === "ok") return "ok";
    return "loading";
  } catch {
    return "down";
  }
}

/**
 * The catalogue's engine.commonArgs without what the launch line already sets
 * (-ngl, --host, --port, --jinja, --no-webui); on the CPU, -fa and the KV cache
 * types stay (llama.cpp takes them there too).
 */
export function engineArgs(common = [], onGpu = true) {
  const out = [];
  const pairs = new Set(["-ngl", "--n-gpu-layers", "--host", "--port", "-c", "--ctx-size", "--parallel", "-np", "--device", "-dev"]);
  const flags = new Set(["--jinja", "--no-webui", "--warmup", "--no-warmup"]);
  for (let i = 0; i < common.length; i++) {
    const a = common[i];
    if (pairs.has(a)) { i++; continue; }
    if (flags.has(a)) continue;
    out.push(a);
  }
  return onGpu ? out : out;
}

/**
 * The engine's own list of GPU devices, from `llama-server --list-devices`:
 *   Vulkan0: AMD Radeon RX 6800M (RADV NAVI22) (12272 MiB, 11533 MiB free)
 * -> [{ index: 0, name: "AMD Radeon RX 6800M (RADV NAVI22)", totalMiB: 12272, freeMiB: 11533 }]
 */
export function parseDevices(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*Vulkan(\d+):\s*(.+?)\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB free)?\)\s*$/);
    if (m) out.push({ index: Number(m[1]), name: m[2].trim(), totalMiB: Number(m[3]), freeMiB: m[4] ? Number(m[4]) : null });
  }
  return out;
}

/** names of graphics built into a processor (shared memory, slow): never the card to fill when another is there */
const INTEGRATED = /RENOIR|CEZANNE|BARCELO|LUCIENNE|PICASSO|RAVEN|REMBRANDT|PHOENIX|HAWK|STRIX|KRACKAN|MENDOCINO|Radeon\(TM\)? Graphics|Radeon Graphics|Vega|Intel|UHD|Iris|Xe Graphics|llvmpipe|lavapipe|SwiftShader/i;

/**
 * Which of the engine's devices is the card GPU brains go to: the one whose
 * memory matches the card the hardware sense reads (within 5%), else the
 * first that is not integrated graphics, else the one with the most memory.
 * Returns { index, name, why } or null when the engine listed none.
 *
 * The order of the list is not stable: on this laptop the RX 6800M was device
 * 1 in October 2026 and device 0 after a kernel update, and a pin on "1" then
 * sent every GPU brain to the integrated chip (found live on 2026-11-13: the
 * 27B "on the GPU" at 2 tokens a second with the card's memory untouched).
 */
export function pickGpuDevice(devices, { vramTotalMiB = 0 } = {}) {
  if (!devices?.length) return null;
  if (vramTotalMiB > 0) {
    const close = devices.filter((d) => Math.abs(d.totalMiB - vramTotalMiB) <= vramTotalMiB * 0.05).sort((a, b) => Math.abs(a.totalMiB - vramTotalMiB) - Math.abs(b.totalMiB - vramTotalMiB));
    const hit = close.find((d) => !INTEGRATED.test(d.name)) ?? close[0];
    if (hit) return { index: hit.index, name: hit.name, why: `its ${hit.totalMiB} MiB match the card the hardware sense reads (${vramTotalMiB} MiB)` };
  }
  const discrete = devices.find((d) => !INTEGRATED.test(d.name));
  if (discrete) return { index: discrete.index, name: discrete.name, why: "it is the first device that is not integrated graphics" };
  const big = [...devices].sort((a, b) => b.totalMiB - a.totalMiB)[0];
  return { index: big.index, name: big.name, why: "every device looks integrated; it has the most memory" };
}

/**
 * Where a brain runs: "cpu" or "gpu". CHRONOS_DEVICE wins, then the
 * catalogue's engine.device ("cpu" puts every brain on the CPU; "auto" or
 * missing leaves it to each brain), then the brain's own "device".
 */
export function deviceOf(brain, engine = {}, env = process.env) {
  const forced = env.CHRONOS_DEVICE || engine.device;
  if (forced === "cpu") return "cpu";
  return brain?.device === "cpu" ? "cpu" : "gpu";
}

/** the root helper scripts/install-gpu-control.sh installs; absent unless the owner ran it */
export const GPU_HELPER = "/usr/local/sbin/chronos-gpu";

/** `sudo -n chronos-gpu <mode> [args...]` (mode may be an array); resolves { ok, out } and never throws */
export function gpuControl(mode, { helper = GPU_HELPER, run = execFile } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(helper)) return resolve({ ok: false, out: "the GPU helper is not installed" });
    run("sudo", ["-n", helper, ...[mode].flat().map(String)], { timeout: 5000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(err ? stderr || err.message : stdout).trim() }));
  });
}

/**
 * The helper's arguments for the catalogue's engine.gpuLimit ({ mhz, mv }): ["limit", MHZ, MV] when it asks for a
 * clock ceiling, a voltage offset or both, null when it asks for neither (missing, or both 0). mhz 0 leaves the
 * clock and mv 0 leaves the voltage, as the helper reads them.
 */
export function gpuLimitArgs(limit) {
  const mhz = Number(limit?.mhz) || 0;
  const mv = Number(limit?.mv) || 0;
  return mhz || mv ? ["limit", String(mhz), String(mv)] : null;
}

/** the CPU threads Chronos may use in all: the cores less the owner's reserve (20%: 12 of 16) */
export function threadBudget(cores = os.cpus().length, reserve = RESERVE) {
  return Math.max(1, Math.floor(cores * (1 - reserve)));
}

/** the thread flags for one brain: a CPU brain gets its own share, never above the budget; a GPU brain needs two */
export function threadArgs(brain, onGpu, budget = threadBudget()) {
  if (onGpu) return ["-t", "2"];
  const n = Math.max(1, Math.min(brain.threads ?? budget, budget));
  return ["-t", String(n), "-tb", String(n)];
}

export class Brains {
  constructor({ root = PROJECT_ROOT, home, bus = quietBus, engineDir, gpuDevice, readJunction, startWaitMs = 120_000, restMs = 12_000, gpu = gpuControl, settleMs = 500, listDevices, vramTotalMiB, platform = process.platform, hasCard, port, cardLock, cardWait, cardPollMs, alive, cardHome: lockHome, reuseHome } = {}) {
    this.platform = platform;
    this.readJunction = readJunction ?? junctionReader();
    this.startWaitMs = startWaitMs;
    /** how long the junction may sit without falling before a waiting start goes ahead */
    this.restMs = restMs;
    // the root helper's caller (tests bring their own, so no test ever touches the real card)
    this.gpu = gpu;
    // how long the driver gets to hand VRAM back after a brain was stopped to make room
    this.settleMs = settleMs;
    this.root = root;
    this.catalogue = loadCatalogue(root);
    // Lite's own home: Windows keeps it under %LOCALAPPDATA% (runtime/platform.mjs); elsewhere it is the catalogue's own
    this.home = home ?? process.env.CHRONOS_LITE_HOME ?? (platform === "win32" ? liteHome({ platform }) : this.catalogue.home);
    this.bus = bus;
    // the card lock every Chronos on this computer shares (runtime/cardlock.mjs): under the full Chronos home
    // (cardHome) when the caller names it, as main() does, or when it names no home at all; a caller that names
    // only a home (a test) keeps the lock there, so a test never touches the real one
    this.cardHome = lockHome ?? (home ? this.home : cardHome());
    this.card = cardLock ?? createCardLock({ home: this.cardHome, port: port ?? (Number(process.env.CHRONOS_LITE_PORT) || null), what: "chronos-lite", waitMs: cardWait ?? cardWaitMs(), pollMs: cardPollMs ?? CARD_POLL_MS, alive: alive ?? pidAlive });
    // GPU starts of this process between taking the card and their engine being up: the lock stays while any runs
    this._cardStarts = 0;
    // the full Chronos home whose engine and brains are used in place, read-only, when they are the pinned build and
    // files (runtime/models.mjs, docs/decisions/0019): named by main(), or the full home when no home is named at all;
    // a caller that names only a home (a test) reuses nothing, so a test never reads the real one
    this.reuseHome = reuseHome !== undefined ? reuseHome : home ? null : chronosHome();
    this._engineDir = engineDir ?? null;
    this._rec = { mtimeMs: -1, record: null };
    // the Vulkan device GPU brains are pinned to: an explicit index (gpuDevice, CHRONOS_GPU) wins; without one
    // the engine is asked for its devices at the first GPU start and the right one is picked (pickGpuDevice)
    this.gpuDevice = gpuDevice ?? process.env.CHRONOS_GPU ?? null;
    this.gpuPick = null;
    this.listDevices = listDevices ?? null;
    this.vramTotalMiB = vramTotalMiB ?? (() => readHardware()?.vram?.totalMiB ?? 0);
    // A machine with no card Chronos can fill (none, or one whose memory the system will not say) runs every
    // brain on the CPU, the same as the catalogue's engine.device "cpu"; CHRONOS_DEVICE still wins.
    const card = hasCard ?? (() => (Number(readHardware()?.vram?.totalMiB) || 0) > 0);
    if (!process.env.CHRONOS_DEVICE && (this.catalogue.engine?.device ?? "auto") !== "cpu" && !(typeof card === "function" ? card() : card)) {
      this.catalogue.engine = { ...(this.catalogue.engine ?? {}), device: "cpu" };
      this.noCard = true;
    }
    // GPU brains run under the governor unless the catalogue or CHRONOS_GOVERNOR=0 says not, and only where it
    // can work: a junction to read and a way to pause a process (throttle.mjs governorCan). Elsewhere they run
    // ungoverned and GET /health says why.
    const wanted = (process.env.CHRONOS_GOVERNOR ?? (this.catalogue.engine?.governor === false ? "0" : "1")) !== "0";
    const can = governorCan({ platform, readJunction: this.readJunction });
    this.governorState = !can.runs ? can : wanted ? { runs: true, why: null } : { runs: false, why: "turned off by the owner (CHRONOS_GOVERNOR=0 or the catalogue's engine.governor): GPU brains run ungoverned" };
    this.governed = this.governorState.runs;
    this.slots = { ...(this.catalogue.slots ?? {}) };
    // id -> { status, child, pid, port, tokensPerSecond, why }
    this.state = new Map();
    for (const brain of this.catalogue.brains) {
      this.state.set(brain.id, { status: "idle", child: null, pid: null, port: brain.port, tokensPerSecond: null, why: null, inflight: 0 });
    }
    // catalogue alternates are shown in list(); the runnable ones (port + file)
    // start by id, never by slot.
    this.catalogueAlternates = this.catalogue.alternates ?? [];
    this.alternates = this.catalogueAlternates.filter((b) => b.port && b.file);
    for (const brain of this.alternates) {
      this.state.set(brain.id, { status: "idle", child: null, pid: null, port: brain.port, tokensPerSecond: null, why: null, inflight: 0 });
    }
    // Children must not outlive the runtime.
    this._onExit = () => {
      for (const s of this.state.values()) {
        if (s.child && s.child.exitCode === null) {
          try { s.gov?.stop(); } catch {}
          try { s.child.kill("SIGKILL"); } catch {}
        }
      }
      // every engine of ours is gone with us: so is our hold on the card
      try { this.card?.release(); } catch { /* the next start finds it stale */ }
    };
    process.on("exit", this._onExit);
  }

  /** `llama-server --list-devices`, with no device pinned so every device is listed; "" when the engine will not say */
  _askDevices() {
    if (this.listDevices) return Promise.resolve(this.listDevices());
    return new Promise((resolve) => {
      const env = { ...process.env, ...(this.catalogue.engine?.env ?? {}) };
      delete env.GGML_VK_VISIBLE_DEVICES;
      execFile(this.engine, ["--list-devices"], { env, cwd: this.home, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => resolve(`${stdout ?? ""}\n${stderr ?? ""}`));
    });
  }

  /**
   * The value of GGML_VK_VISIBLE_DEVICES for a GPU brain: the explicit pin, else the engine's device that is the
   * real card, asked once and remembered. When the engine lists nothing, "0" (and the log says it is a guess).
   */
  async _gpuIndex() {
    if (this.gpuDevice != null && this.gpuDevice !== "") return String(this.gpuDevice);
    // macOS runs on Metal: there is one GPU and no Vulkan device to pick
    if (this.platform === "darwin") return "0";
    if (this.gpuPick) return String(this.gpuPick.index);
    let devices = [];
    try {
      devices = parseDevices(await this._askDevices());
    } catch {
      /* the engine would not list its devices */
    }
    const pick = pickGpuDevice(devices, { vramTotalMiB: Number(this.vramTotalMiB()) || 0 });
    if (!pick) {
      this.gpuPick = { index: 0, name: null, why: "the engine listed no device" };
      this.bus.emit("log", { level: "warn", text: "the engine listed no GPU device: GPU brains are pinned to device 0, which is a guess (set CHRONOS_GPU to the right index)" });
      return "0";
    }
    this.gpuPick = pick;
    const others = devices.filter((d) => d.index !== pick.index).map((d) => `Vulkan${d.index} ${d.name}`);
    this.bus.emit("log", { text: `GPU brains go to Vulkan${pick.index}, ${pick.name}: ${pick.why}${others.length ? ` (left alone: ${others.join(", ")})` : ""}`, gpu: pick });
    return String(pick.index);
  }

  /** After a GPU brain is up: its log names the device it used; say so loudly when it is not the one picked. */
  _checkDevice(id) {
    try {
      const want = this.gpuPick?.name;
      if (!want) return;
      // the log is appended to across starts: the last "using device" line is this start's
      const all = [...readFileSync(this.logPath(id), "utf8").matchAll(/using device \S+ \((.+?)\) \(/g)];
      const got = all.at(-1)?.[1]?.trim();
      if (got && got !== want) this.bus.emit("log", { level: "error", id, text: `${id} loaded on ${got}, not on ${want}: it is on the wrong GPU` });
    } catch {
      /* no log to read */
    }
  }

  // Wait (at most startWaitMs) for the junction to fall under startC before a GPU brain loads. The wait is for a
  // card that is cooling down from work; one that sits above startC at rest (this laptop idles near 80 C) will
  // never get there, so the wait ends as soon as the junction has stopped falling for restMs.
  async _coolForStart(startC, id) {
    const until = Date.now() + this.startWaitMs;
    let said = false;
    let low = Infinity;
    let lowAt = Date.now();
    for (;;) {
      const j = this.readJunction();
      if (!Number.isFinite(j) || j < startC || Date.now() >= until) return;
      if (j < low) {
        low = j;
        lowAt = Date.now();
      } else if (Date.now() - lowAt >= this.restMs) {
        this.bus.emit("log", { id, text: `the GPU junction rests at ${j} C and is not falling: ${id} loads now` });
        return;
      }
      if (!said) {
        this.bus.emit("log", { id, text: `${id} waits for the GPU junction to fall from ${j} C under ${startC} C before it loads` });
        said = true;
      }
      await sleep(Math.min(2000, Math.max(50, this.restMs / 4)));
    }
  }

  /** One GPU start at a time: fn runs when the start before it has launched its server (or given up). */
  async _gpuTurn(fn) {
    const before = this._turn ?? Promise.resolve();
    let done;
    this._turn = new Promise((r) => (done = r));
    await before;
    try {
      return await fn();
    } finally {
      done();
    }
  }

  /** this process's GPU brains whose engine is alive: [{ id, pid }] */
  _gpuEngines() {
    const out = [];
    for (const [id, s] of this.state) {
      const brain = this.catalogue.brains.find((b) => b.id === id) ?? this.alternates.find((b) => b.id === id);
      if (!brain || deviceOf(brain, this.catalogue.engine) !== "gpu") continue;
      if (s.child && s.child.exitCode === null && s.child.signalCode === null) out.push({ id, pid: s.pid });
    }
    return out;
  }

  /** after a GPU brain came or went: the lock lists the engines that run, or goes when none does and none is starting */
  _cardSync() {
    if (!this.card?.held) return;
    const engines = this._gpuEngines();
    try {
      if (!engines.length && !this._cardStarts) {
        if (this.card.release()) this.bus.emit("log", { text: "the card is free: this Chronos has no brain on it any more" });
      } else this.card.setEngines(engines);
    } catch (err) {
      this.bus.emit("log", { level: "warn", text: `the card lock could not be updated: ${err?.message ?? err}` });
    }
  }

  /**
   * Take the card for a GPU brain: at once when no other process holds it (or the one that did is gone), else wait
   * with the brain's status "waiting" until it is free or CHRONOS_GPU_WAIT_MS runs out. Throws when it runs out
   * or the brain is stopped while it waits.
   */
  async _takeCard(id, s) {
    s.cancelWait = false;
    try {
      await this.card.acquire(id, {
        cancelled: () => s.cancelWait,
        onTakeover: (stale, text) => this.bus.emit("log", { id, text, card: stale }),
        onWait: (holder, text) => {
          s.status = "waiting";
          s.why = text;
          s.waitingFor = holder;
          this.bus.emit("brain.waiting", { id, holder, text });
        },
      });
    } catch (err) {
      if (err?.code === "CARD_CANCELLED") throw err; // stop() already said idle
      s.status = "failed";
      s.why = err?.message ?? String(err);
      s.waitingFor = null;
      this.bus.emit("brain.failed", { id, port: this.brainOf(id).port, pid: null, why: s.why });
      throw err;
    } finally {
      s.cancelWait = false;
    }
    if (s.status === "waiting") {
      s.status = "idle";
      s.why = null;
      s.waitingFor = null;
    }
  }

  /** a brain's engine went away: a ready one that was not being stopped has failed; the card is given back when it was the last */
  _childExited(id, child, code) {
    const s = this.state.get(id);
    if (s && s.child === child && !s.stopping && s.status === "ready") {
      s.gov?.stop();
      s.gov = null;
      s.status = "failed";
      s.child = null;
      s.pid = null;
      s.why = `its engine exited (${code}) while it was ready; see ${this.logPath(id)}.`;
      this.bus.emit("brain.failed", { id, port: this.brainOf(id).port, pid: child.pid, why: s.why });
    }
    this._cardSync();
  }

  /**
   * The exclusive rule, before a GPU brain loads: an exclusive brain stops
   * every other GPU brain that is up; any other GPU brain stops an exclusive
   * one that is up. CPU brains are left alone. Says why on the bus and
   * returns the ids it stopped.
   */
  async _alone(brain) {
    const engine = this.catalogue.engine;
    const up = this.catalogue.brains.filter((b) => {
      const st = this.state.get(b.id);
      return b.id !== brain.id && deviceOf(b, engine) === "gpu" && (st.child || st.status === "ready" || st.status === "loading");
    });
    const out = brain.exclusive ? up : up.filter((b) => b.exclusive);
    if (!out.length) return [];
    const ids = out.map((b) => b.id);
    const text = brain.exclusive
      ? `${brain.id} is exclusive: it runs alone on the GPU, so ${ids.join(" and ")} stop${ids.length === 1 ? "s" : ""} before it loads`
      : `${ids.join(" and ")} ${ids.length === 1 ? "is" : "are"} exclusive (alone on the GPU): ${ids.length === 1 ? "it stops" : "they stop"} before ${brain.id} loads`;
    this.bus.emit("log", { id: brain.id, text, exclusive: true, stopped: ids });
    for (const b of out) await this.stop(b.id);
    // Give the driver a moment to hand the VRAM back before fits() reads it.
    if (this.settleMs) await sleep(this.settleMs);
    return ids;
  }

  /** true while a governed brain is running on the GPU: the watchdog then leaves the holding to the governor */
  get governing() {
    return [...this.state.values()].some((x) => x.gov && x.status !== "idle");
  }

  /** the engine's server binary, by this system's file name (llama-server, llama-server.exe on Windows) */
  get engine() {
    return path.join(this.engineDir, engineFile(this.platform));
  }

  /** the engine's folder: the one named, else Lite's own bin/llama, else the full Chronos one reuse.json vouches for */
  get engineDir() {
    return this._engineDir ?? resolveEngineDir({ home: this.home, reuseHome: this.reuseHome, record: this.record(), build: this.catalogue.engine?.build, platform: this.platform });
  }

  /** reuse.json under the home (runtime/models.mjs), read again only when it changed */
  record() {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path.join(this.home, RECORD)).mtimeMs;
    } catch {
      /* no record */
    }
    if (mtimeMs !== this._rec.mtimeMs) this._rec = { mtimeMs, record: readRecord(this.home) };
    return this._rec.record;
  }

  /** where a brain's file is: Lite's own, or a vouched-for one in the full Chronos home; { where, path } or null */
  locate(brain, kind = "model") {
    const f = filesOf(brain).find((x) => x.kind === kind);
    return f ? resolveFile(f, { home: this.home, reuseHome: this.reuseHome, record: this.record() }) : null;
  }

  /** { runs, why }: whether GPU brains run under the governor here, and why not when they do not (GET /health) */
  governorStatus() {
    return { ...this.governorState };
  }

  brainOf(id) {
    const brain = this.catalogue.brains.find((b) => b.id === id) ?? this.alternates.find((b) => b.id === id);
    if (!brain) throw new Error(`No brain "${id}" in the catalogue.`);
    return brain;
  }

  modelPath(brain) {
    return this.locate(brain)?.path ?? path.join(this.home, "models", brain.file);
  }

  /** the vision projector of a brain that has one in the catalogue (brain.mmproj), or null */
  mmprojPath(brain) {
    return brain?.mmproj && brain.vision ? (this.locate(brain, "mmproj")?.path ?? path.join(this.home, "models", brain.mmproj)) : null;
  }

  /** whether the brain would see pictures if started now: it is a vision brain and its projector is on disk */
  canSee(brain) {
    const p = this.mmprojPath(brain);
    return !!p && existsSync(p);
  }

  logPath(id) {
    return path.join(this.home, "logs", `${id}.log`);
  }

  urlOf(id) {
    return `http://127.0.0.1:${this.brainOf(id).port}`;
  }

  slotOf(id) {
    return Object.keys(this.slots).find((slot) => this.slots[slot] === id) ?? null;
  }

  present(brain) {
    if (!brain?.file) return false;
    return existsSync(this.modelPath(brain));
  }

  list() {
    const row = (brain, { alternate = false } = {}) => {
      const s = this.state.get(brain.id);
      return {
        id: brain.id,
        name: brain.name,
        role: brain.role,
        file: brain.file,
        port: brain.port,
        ctx: brain.ctx,
        vramMiB: brain.vramMiB,
        ramMiB: brain.ramMiB ?? null,
        device: deviceOf(brain, this.catalogue.engine),
        exclusive: !!brain.exclusive,
        ...(alternate ? { alternate: true, engine: brain.engine ?? this.catalogue.engine?.id ?? "llama.cpp" } : {}),
        thinking: !!brain.thinking,
        // a running brain sees pictures when it was started with its projector; one at rest, when the projector is on disk
        vision: s?.status === "ready" || s?.status === "loading" ? !!s.vision : this.canSee(brain),
        ...(brain.mmproj && brain.vision ? { mmproj: { file: brain.mmproj, present: !!this.mmprojPath(brain) && existsSync(this.mmprojPath(brain)) } } : {}),
        parallel: brain.parallel ?? 1,
        present: this.present(brain),
        // whose copy it runs from: "lite" (its own home), "chronos" (the full Chronos home's, in place) or null
        where: brain.file ? (this.locate(brain)?.where ?? null) : null,
        status: s?.status ?? "catalogue",
        pid: s?.pid ?? null,
        slot: alternate ? null : this.slotOf(brain.id),
        tokensPerSecond: s?.tokensPerSecond ?? null,
        busy: s?.inflight ?? 0,
        governor: s?.gov ? s.gov.stats() : null,
        // while a GPU start waits for the card: who holds it, and the sentence that says so
        ...(s?.status === "waiting" ? { waitingFor: s.waitingFor ?? null, why: s.why ?? null } : {}),
      };
    };
    return [...this.catalogue.brains.map((brain) => row(brain)), ...this.catalogueAlternates.map((brain) => row(brain, { alternate: true }))];
  }

  // Start one brain's server and wait until it answers /health with ok.
  async start(id, { ctx, parallel } = {}) {
    const brain = this.brainOf(id);
    const s = this.state.get(id);
    if (s.status === "ready") return { id, port: brain.port, pid: s.pid };
    if (s.status === "loading") throw new Error(`Brain "${id}" is already loading.`);
    if (s.status === "waiting") throw new Error(`Brain "${id}" is already waiting for the card: ${s.why ?? "another Chronos holds it"}`);

    const model = this.modelPath(brain);
    if (!existsSync(model)) throw new Error(`Brain "${id}" is not downloaded: ${model} is missing.`);
    if (!existsSync(this.engine)) throw new Error(`The engine is missing: ${this.engine}.`);

    const onGpu = deviceOf(brain, this.catalogue.engine) === "gpu";
    const engine = this.catalogue.engine ?? {};
    const url = this.urlOf(id);
    const server = "llama-server";

    // From the exclusive rule to the spawn, one GPU start at a time.
    const launch = async () => {
      // someone may have started it while this start waited its turn
      if (s.status === "ready") return null;
      if (s.status === "loading") throw new Error(`Brain "${id}" is already loading.`);
      if (s.status === "waiting") throw new Error(`Brain "${id}" is already waiting for the card.`);

      // The card is one for every Chronos on this computer: this process takes it before anything loads on it.
      if (onGpu) await this._takeCard(id, s);

      // An exclusive brain is alone on the GPU: whoever must go, goes first.
      if (onGpu) await this._alone(brain);

      // A brain on the CPU asks for RAM and is not held back by the GPU's heat.
      // (a brain meant for the card that runs on the CPU holds the whole model in RAM: the larger of its two figures)
      // a projector the catalogue puts on the card takes its own room there
      let projMiB = 0;
      if (onGpu && brain.mmprojOnGpu && this.canSee(brain)) try { projMiB = Math.ceil(statSync(this.mmprojPath(brain)).size / 1048576); } catch { /* counted as none */ }
      const fit = fits(onGpu ? { vramMiB: (brain.vramMiB ?? 0) + projMiB } : { ramMiB: brain.device === "cpu" ? (brain.ramMiB ?? brain.vramMiB) : Math.max(brain.ramMiB ?? 0, brain.vramMiB ?? 0) }, readHardware());
      if (!fit.ok) throw new Error(`Cannot start "${id}": ${fit.why}`);

      // Someone else's server on our port would answer our polls and fool us.
      if ((await health(url)) !== "down") {
        throw new Error(`Cannot start "${id}": port ${brain.port} is already taken by another server.`);
      }

      mkdirSync(path.dirname(this.logPath(id)), { recursive: true });
      // A vision brain loads its projector when it is on disk, so pictures can be sent to it. The projector runs on
      // the CPU unless the catalogue says mmprojOnGpu: on this card it would take ~900 MiB of VRAM the 4B needs beside it.
      const seeing = this.canSee(brain);
      const mmprojArgs = seeing ? ["--mmproj", this.mmprojPath(brain), ...(onGpu && brain.mmprojOnGpu ? [] : ["--no-mmproj-offload"])] : brain.mmproj ? ["--no-mmproj"] : [];
      const fd = openSync(this.logPath(id), "a");
      const args = [
        "-m", model,
        "--host", "127.0.0.1",
        "--port", String(brain.port),
        "-ngl", onGpu ? String(brain.ngl ?? 99) : "0",
        ...(onGpu ? [] : ["--device", "none"]),
        "-c", String(ctx ?? brain.ctx),
        "--parallel", String(parallel ?? brain.parallel ?? 1),
        "--jinja",
        "--no-webui",
        // The warmup is an empty full-power run the moment the model loads; on this
        // laptop it took the junction from the 70s past 100 C in seconds.
        "--no-warmup",
        ...threadArgs(brain, onGpu),
        // The catalogue's own flags: --cache-ram, -fa, the KV cache types, speculation.
        ...engineArgs(engine.commonArgs, onGpu),
        ...(brain.args ?? []),
        ...mmprojArgs,
        // Under the governor a pause cannot cut GPU work already submitted, so
        // prompts go in small batches.
        // Only the physical batch shrinks: the logical batch (-b) must keep room
        // for speculative drafts, or llama-server aborts ("batch must be large
        // enough to hold the sampled and draft tokens").
        ...(onGpu && this.governed && !(brain.args ?? []).includes("-ub") ? ["-ub", String(brain.ub ?? 8)] : []),
        // Verbosity 4 writes the device and "offloaded N/N layers to GPU" lines
        // into the log, so the record shows where the model went.
        "-lv", "4",
      ];
      // A GPU brain loads only on a cool card: its load and first prompt are its hottest moments.
      const gpuIndex = onGpu ? await this._gpuIndex() : "-1";
      if (onGpu) await this._coolForStart(engine.startC ?? 74, id);
      const spawned = spawn(this.engine, args, {
        cwd: this.home,
        env: { ...process.env, ...(engine.env ?? {}), GGML_VK_VISIBLE_DEVICES: gpuIndex },
        stdio: ["ignore", fd, fd],
        detached: false,
        windowsHide: true,
      });
      closeSync(fd);

      // Below the owner's own programs: Chronos takes what is left over.
      try { os.setPriority(spawned.pid, 10); } catch { /* not ours to lower */ }
      s.status = "loading";
      s.vision = seeing;
      s.child = spawned;
      s.pid = spawned.pid;
      // whenever it goes (stopped, crashed, killed from outside), the card lock hears of it
      spawned.once("exit", (code, signal) => this._childExited(id, spawned, code ?? signal));
      if (onGpu) this._cardSync();
      return spawned;
    };
    // A GPU start holds the card from taking it until its engine is up; if it gives up before, the card goes back.
    const onCard = async () => {
      this._cardStarts++;
      try {
        return await launch();
      } finally {
        this._cardStarts--;
        this._cardSync();
      }
    };
    const child = onGpu ? await this._gpuTurn(onCard) : await launch();
    if (!child) return { id, port: brain.port, pid: s.pid };
    // With the root helper and overdrive, the GPU is limited before a GPU brain
    // loads (chronos-gpu limit MHZ MV): its top clock lowered, its voltage
    // offset set, or both. Either one alone is a limit: this card's overdrive
    // has no clock ceiling, so the catalogue asks for mhz 0 (leave the clock)
    // with -50 mV, and a guard on mhz alone never applied that undervolt.
    // Masking the clock states ("cap") does nothing on this RDNA2 card:
    // measured 117-126 W and 101-106 C with it set. Without overdrive the
    // governor alone holds the heat.
    const limit = onGpu ? gpuLimitArgs(engine.gpuLimit) : null;
    if (limit) {
      const lim = await this.gpu(limit);
      this.bus.emit("log", { text: lim.ok ? `GPU limited for ${id}: ${lim.out}` : `GPU limit not applied (${lim.out.trim().slice(0, 120)}); the governor alone holds the heat` });
    }
    // The governor caps a GPU brain from its first second, the load included.
    // Every GPU brain joins the one governor: they share the card.
    if (onGpu && this.governed) {
      const g = engine.governor && typeof engine.governor === "object" ? engine.governor : {};
      // the owner's CHRONOS_TARGET_C and CHRONOS_DUTY_MAX win over the catalogue's numbers
      this.governor ??= createGovernor({
        bus: this.bus,
        readJunction: this.readJunction,
        target: Number(process.env.CHRONOS_TARGET_C) || g.targetC,
        max: Number(process.env.CHRONOS_DUTY_MAX) || g.dutyMax,
        on: g.onMs,
        hold: g.holdC,
        peak: g.peakC,
      });
      s.gov = this.governor.add(child.pid, id);
    } else s.gov = null;
    s.why = null;
    this.bus.emit("brain.loading", { id, port: brain.port, pid: child.pid });

    let exited = false;
    let exitCode = null;
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? signal;
    });
    child.once("error", () => { exited = true; });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) break;
      if ((await health(url)) === "ok") {
        s.gov?.loaded();
        s.status = "ready";
        if (onGpu) this._checkDevice(id);
        this.bus.emit("brain.ready", { id, port: brain.port, pid: child.pid });
        return { id, port: brain.port, pid: child.pid };
      }
      await sleep(HEALTH_POLL_MS);
    }

    const why = exited
      ? `${server} exited (${exitCode}) before it was ready; see ${this.logPath(id)}.`
      : `${server} did not answer /health within ${HEALTH_TIMEOUT_MS / 1000} s; see ${this.logPath(id)}.`;
    s.gov?.stop();
    s.gov = null;
    if (!exited) await this._kill(child);
    s.status = "failed";
    s.child = null;
    s.pid = null;
    s.why = why;
    this.bus.emit("brain.failed", { id, port: brain.port, pid: child.pid, why });
    throw new Error(`Brain "${id}" failed to start: ${why}`);
  }

  // SIGTERM, then SIGKILL when it has not gone after the grace period.
  async _kill(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    try { child.kill("SIGTERM"); } catch { return; }
    const timer = sleep(STOP_GRACE_MS).then(() => "timeout");
    if ((await Promise.race([gone, timer])) === "timeout") {
      try { child.kill("SIGKILL"); } catch {}
      await gone;
    }
  }


  async stop(id) {
    const brain = this.brainOf(id);
    const s = this.state.get(id);
    // a start that waits for the card is called off: nothing of it runs yet
    if (s.status === "waiting") {
      s.cancelWait = true;
      s.status = "idle";
      s.why = null;
      s.waitingFor = null;
      this.bus.emit("brain.stopped", { id, port: brain.port, pid: null, waited: true });
      return { id, port: brain.port, pid: null };
    }
    const { child, pid } = s;
    s.stopping = true;
    try {
      return await this._stop(id, brain, s, child, pid);
    } finally {
      s.stopping = false;
      this._cardSync();
    }
  }

  async _stop(id, brain, s, child, pid) {
    // a paused process does not act on SIGTERM: let it run free first
    s.gov?.stop();
    s.gov = null;
    if (child) await this._kill(child);
    s.status = "idle";
    s.child = null;
    s.pid = null;
    if (child) this.bus.emit("brain.stopped", { id, port: brain.port, pid });
    // the last GPU brain gone: give the GPU back to the driver
    const gpuLeft = this.catalogue.brains.some((b) => b.id !== id && deviceOf(b, this.catalogue.engine) === "gpu" && this.state.get(b.id)?.child);
    if (child && deviceOf(brain, this.catalogue.engine) === "gpu" && !gpuLeft) await this.gpu("auto");
    return { id, port: brain.port, pid };
  }

  // Put another brain in a slot: refuse (and change nothing) when it will
  // not fit once the current one is unloaded; otherwise stop, start, record.
  async switchSlot(slot, id) {
    if (!(slot in this.slots)) throw new Error(`No slot "${slot}" in the catalogue.`);
    const next = this.brainOf(id);
    if (!this.catalogue.brains.includes(next)) throw new Error(`Brain "${id}" is an alternate: start it by id, it does not go in a slot.`);
    const currentId = this.slots[slot];
    if (currentId === id && this.state.get(id).status === "ready") return { slot, id, pid: this.state.get(id).pid };

    const model = this.modelPath(next);
    if (!existsSync(model)) throw new Error(`Brain "${id}" is not downloaded: ${model} is missing.`);

    // Credit back the VRAM the current brain holds; it is about to go.
    const hw = readHardware();
    const current = this.catalogue.brains.find((b) => b.id === currentId);
    if (current && this.state.get(currentId)?.status === "ready") {
      hw.vram.freeMiB = Math.min(hw.vram.totalMiB, hw.vram.freeMiB + current.vramMiB);
    }
    const fit = fits({ vramMiB: next.vramMiB }, hw);
    if (!fit.ok) throw new Error(`Cannot switch "${slot}" to "${id}": ${fit.why}`);

    if (current && currentId !== id) {
      await this.stop(currentId);
      // Give the driver a moment to hand the VRAM back before we read it again.
      await sleep(500);
    }
    const started = await this.start(id);
    this.slots[slot] = id;
    this.bus.emit("brain.switched", { slot, id, from: currentId, pid: started.pid });
    return { slot, id, from: currentId, pid: started.pid };
  }

  // POST /v1/chat/completions in the OpenAI shape.
  async chat(id, messages, { tools, json_schema, maxTokens, thinking = false, temperature } = {}) {
    const brain = this.brainOf(id);
    const s = this.state.get(id);
    const body = { model: brain.id, messages, chat_template_kwargs: { enable_thinking: thinking } };
    if (tools?.length) body.tools = tools;
    if (json_schema) {
      body.response_format = { type: "json_schema", json_schema: { name: json_schema.name ?? "answer", schema: json_schema.schema ?? json_schema } };
      // A brain launched with --reasoning-format none (the workers, for their tool calls) keeps the template's
      // empty <think></think> in the answer when thinking is off, and the JSON grammar then refuses that prefix:
      // "Failed to initialize samplers" before a single token (seen live 2026-11-13, the 0.8B judging the 4B).
      // Asking for the parsed format on this one request lets the grammar start after the thinking block.
      body.reasoning_format = "auto";
    }
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;

    s.gov?.busy(1);
    s.inflight++;
    let res, raw;
    try {
      // postJson, not fetch: fetch gives up after five minutes without an answer, and a governed brain can need
      // longer for one prompt (runtime/post.mjs)
      res = await postJson(`${this.urlOf(id)}/v1/chat/completions`, body);
      raw = await res.json().catch(() => ({}));
    } finally {
      s.gov?.busy(-1);
      s.inflight--;
    }
    if (!res.ok) {
      const why = raw?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`Brain "${id}" refused the chat: ${why}`);
    }
    const message = raw.choices?.[0]?.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((call) => {
      let args = call.function?.arguments ?? "{}";
      try { args = JSON.parse(args); } catch { /* keep the raw string */ }
      return { id: call.id, name: call.function?.name, arguments: args };
    });
    const tokensPerSecond = raw.timings?.predicted_per_second ?? null;
    if (tokensPerSecond != null) s.tokensPerSecond = Math.round(tokensPerSecond * 10) / 10;
    return { content: message.content ?? "", toolCalls, usage: raw.usage ?? null, tokensPerSecond, raw };
  }


  /**
   * The same chat, streamed: POST /v1/chat/completions with stream: true.
   * onDelta({text}) or onDelta({thinking}) is called as the tokens come; the
   * thinking is the server's reasoning_content, or what the brain wrote inline
   * between <think> and </think>. `signal` stops it. Resolves
   * {content, thinking, usage, tokensPerSecond, finish}; an error carries
   * what had come so far as err.partial.
   */
  async chatStream(id, messages, { maxTokens, thinking = false, temperature, signal, onDelta } = {}) {
    const brain = this.brainOf(id);
    const s = this.state.get(id);
    const body = { model: brain.id, messages, chat_template_kwargs: { enable_thinking: thinking }, stream: true, stream_options: { include_usage: true } };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
    const sent = body;

    let content = "";
    let thought = "";
    let usage = null;
    let timings = null;
    let finish = null;
    const split = thinkSplitter();
    const take = (parts) => {
      for (const p of parts) {
        if (p.text) content += p.text;
        if (p.thinking) thought += p.thinking;
        try {
          onDelta?.(p);
        } catch {
          /* a listener that throws does not stop the stream */
        }
      }
    };
    const started = Date.now();
    s.gov?.busy(1);
    s.inflight++;
    try {
      const res = await postJson(`${this.urlOf(id)}/v1/chat/completions`, sent, { signal });
      if (!res.ok) {
        const raw = await res.json().catch(() => ({}));
        throw new Error(`Brain "${id}" refused the chat: ${raw?.error?.message ?? `HTTP ${res.status}`}`);
      }
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(`Brain "${id}" failed mid-answer: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) usage = chunk.usage;
        if (chunk.timings) timings = chunk.timings;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        const d = choice?.delta ?? {};
        if (typeof d.reasoning_content === "string" && d.reasoning_content) take([{ thinking: d.reasoning_content }]);
        if (typeof d.content === "string" && d.content) take(split.push(d.content));
      }
      take(split.end());
    } catch (err) {
      err.partial = { content, thinking: thought };
      throw err;
    } finally {
      s.gov?.busy(-1);
      s.inflight--;
    }
    const seconds = (Date.now() - started) / 1000;
    const tokensPerSecond = timings?.predicted_per_second ?? (usage?.completion_tokens && seconds > 0 ? usage.completion_tokens / seconds : null);
    if (tokensPerSecond != null) s.tokensPerSecond = Math.round(tokensPerSecond * 10) / 10;
    return { content: thought ? content.replace(/^\s+/, "") : content, thinking: thought, usage, tokensPerSecond, finish };
  }

  async stopAll() {
    await Promise.all([...this.state.keys()].map((id) => this.stop(id)));
  }

  // Let the exit hook go when the instance is finished with; the card goes back when no brain of ours is on it.
  dispose() {
    process.off("exit", this._onExit);
    this._cardSync();
  }

  /** for GET /health: the card lock as it is on disk, and whether it is this process's */
  cardStatus() {
    try {
      return this.card.status();
    } catch {
      return { lock: null, mine: false };
    }
  }
}
