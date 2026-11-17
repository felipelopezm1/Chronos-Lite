// The card lock: one Chronos process on the GPU card at a time.
//
// Every Chronos on this computer (the desktop app's runtime, a checkout's, a
// test's, the heat probe) shares the home (~/.chronos), so a file there is
// seen by all of them. A process that starts a brain on the card first creates
// <home>/run/gpu.lock, atomically, holding { pid, port, brain, since, host,
// what, id, engines }; it removes the file when its last GPU brain is gone.
// While another live process holds it, a GPU start waits (CHRONOS_GPU_WAIT_MS,
// 10 minutes by default, a look every 2 s) and then fails: it never falls back
// to the CPU on its own. On 2026-11-14 the desktop app's 27B and a heat probe's
// 9B ran on the card together and took the junction to 99 C.
//
// The file is written whole beside the lock and then linked into place
// (link fails when the lock exists), so a reader never sees it half written.
// A lock is stale when neither its process nor any of its engines (the
// llama-servers it started, which outlive a runtime killed with SIGKILL) is
// alive; a stale lock is renamed aside and the card taken. A lock from another
// host (a home shared over the network) is never judged stale from here.
//
// On Windows a file another process has open, or one just deleted while a
// reader still holds it, answers EPERM, EACCES or EBUSY for a moment where
// Linux and macOS never do; there those mean "look again", not a failure.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { momentary, pauseSync, settled as settledOn } from "./files.mjs";

export { momentary };

/** how long a GPU start waits for the card by default: 10 minutes */
export const CARD_WAIT_MS = 600_000;
/** how often a waiting start looks again */
export const CARD_POLL_MS = 2_000;

/** <home>/run/gpu.lock */
export function cardLockPath(home) {
  return path.join(home, "run", "gpu.lock");
}

/** whether a process is alive: signal 0 asks without sending; EPERM is someone else's live process */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readLock(file, { fsApi = fs, platform = process.platform } = {}) {
  try {
    const parsed = JSON.parse(fsApi.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { corrupt: true };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    if (momentary(err, platform)) return { busy: true };
    return { corrupt: true, why: err?.message ?? String(err) };
  }
}

/** the lock as it is now (read each time), or null when the card is free */
export function readCardLock(home) {
  const lock = readLock(cardLockPath(home));
  return lock?.busy ? { corrupt: true, why: "the lock file is busy" } : lock;
}

/** CHRONOS_GPU_WAIT_MS when it is a number (0 included), else the default */
export function cardWaitMs(env = process.env) {
  const raw = env.CHRONOS_GPU_WAIT_MS;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : CARD_WAIT_MS;
}

/** "qwen3.8-27b of the Chronos on port 7778 (pid 4242)", in the owner's words */
export function describeHolder(lock, { alive = pidAlive } = {}) {
  if (!lock) return "nothing";
  if (lock.corrupt) return "a lock file that cannot be read";
  if (lock.busy) return "a lock file another process has open this moment";
  const who = lock.port ? `the Chronos on port ${lock.port}` : `${lock.what || "a Chronos process"}`;
  let text = `${lock.brain || "a brain"} of ${who} (pid ${lock.pid}${lock.host && lock.host !== os.hostname() ? ` on ${lock.host}` : ""})`;
  const engines = (lock.engines ?? []).filter((p) => alive(p));
  if (!alive(lock.pid) && engines.length) text += `; that process is gone but its engine (pid ${engines.join(", ")}) still runs on the card`;
  return text;
}

/**
 * One process's hold on the card. acquire(brain) takes it or waits; release()
 * gives it back (only a lock that is this one's own is ever removed);
 * setEngines() keeps the lock's list of engines and brains current.
 * pid, alive, host, sleep, fsApi and platform are the test's to replace.
 */
export function createCardLock({ home, port = null, what = path.basename(process.argv[1] ?? "node"), pid = process.pid, host = os.hostname(), alive = pidAlive, waitMs = cardWaitMs(), pollMs = CARD_POLL_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fsApi = fs, platform = process.platform, pause = pauseSync } = {}) {
  const file = cardLockPath(home);
  const fs = fsApi;
  const readJson = (f) => readLock(f, { fsApi, platform });
  /** read the lock, looking again a few times while Windows has it in another process's hands */
  const readSettled = (f) => {
    let lock = readJson(f);
    for (let i = 0; lock?.busy && i < 5; i++) {
      pause(20);
      lock = readJson(f);
    }
    return lock;
  };
  /** run a write, again a few times while Windows says the file is in someone's hands (release runs from an exit handler: it waits in place) */
  const settled = (fn) => settledOn(fn, { platform, pause });
  const id = `${pid}-${randomUUID().slice(0, 8)}`;
  let held = false;
  let record = null;
  let n = 0;

  const live = (lock) => {
    if (!lock || lock.corrupt) return false;
    if (lock.busy) return true; // in another process's hands this moment: never judged stale
    if (lock.host && lock.host !== host) return true; // another machine's process cannot be asked from here
    return alive(lock.pid) || (lock.engines ?? []).some((p) => alive(p));
  };
  const same = (a, b) => (a?.id && b?.id ? a.id === b.id : JSON.stringify(a) === JSON.stringify(b));

  /** create the lock with its whole content in one step; false when one is there */
  const create = (rec) => {
    const tmp = `${file}.${id}.${++n}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (err) {
      if (err?.code === "EEXIST" || momentary(err, platform)) return false;
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
    }
  };

  /** one try: { ok: true, lock, tookOver? } or { ok: false, holder } */
  function tryTake(brain) {
    if (held) return { ok: true, lock: record };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let tookOver = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const rec = { pid, port, brain, since: new Date(now()).toISOString(), host, what, id, engines: [] };
      if (create(rec)) {
        held = true;
        record = rec;
        return { ok: true, lock: rec, ...(tookOver ? { tookOver } : {}) };
      }
      const lock = readJson(file);
      if (!lock) continue; // released between the two looks
      if (lock.id === id) {
        held = true;
        record = lock;
        return { ok: true, lock };
      }
      if (live(lock)) return { ok: false, holder: lock };
      // stale: move it aside, then make sure it was the stale one that moved
      const aside = `${file}.stale-${id}-${++n}`;
      try {
        fs.renameSync(file, aside);
      } catch (err) {
        if (err?.code === "ENOENT") continue; // someone else moved it first
        if (momentary(err, platform)) continue; // another process has it open this moment
        throw err;
      }
      const moved = readJson(aside);
      if (moved && !same(moved, lock) && live(moved)) {
        // a fresh lock was made between the read and the rename: it goes back where it was
        try { fs.linkSync(aside, file); } catch { /* another took its place; it holds now */ }
        try { fs.unlinkSync(aside); } catch { /* gone */ }
        return { ok: false, holder: moved };
      }
      try { fs.unlinkSync(aside); } catch { /* gone */ }
      tookOver = lock;
    }
    return { ok: false, holder: readJson(file) ?? { corrupt: true, why: "the lock kept changing" } };
  }

  /**
   * Take the card for brain, waiting while another live process holds it.
   * onWait(holder, text) is called once when the wait begins; cancelled() is
   * asked between looks. Throws when the wait runs out (err.code CARD_BUSY,
   * err.holder) or is cancelled (err.code CARD_CANCELLED).
   */
  async function acquire(brain, { onWait, onTakeover, cancelled } = {}) {
    const until = now() + waitMs;
    let said = false;
    for (;;) {
      const r = tryTake(brain);
      if (r.ok) {
        if (r.tookOver) onTakeover?.(r.tookOver, `the card lock of ${describeHolder(r.tookOver, { alive })} was stale (nothing of it runs): ${brain} takes the card`);
        return r;
      }
      if (cancelled?.()) {
        const err = new Error(`${brain} was stopped while it waited for the card`);
        err.code = "CARD_CANCELLED";
        throw err;
      }
      const who = describeHolder(r.holder, { alive });
      if (now() >= until) {
        const err = new Error(`the card is in use by ${who}; ${brain} waited ${Math.round(waitMs / 1000)} s and did not start (it does not move to the CPU on its own: stop the other brain, or start this one on the CPU)`);
        err.code = "CARD_BUSY";
        err.holder = r.holder;
        throw err;
      }
      if (!said) {
        onWait?.(r.holder, `the card is in use by ${who}; waiting`);
        said = true;
      }
      await sleep(Math.max(1, Math.min(pollMs, until - now())));
    }
  }

  /** keep the lock's engines (pids) and brains current while it is held */
  function setEngines(list) {
    if (!held || !record) return;
    const engines = list.map((e) => e.pid).filter(Boolean);
    const brains = list.map((e) => e.id).filter(Boolean);
    const next = { ...record, engines, ...(brains.length ? { brain: brains.join(", ") } : {}) };
    if (JSON.stringify(next) === JSON.stringify(record)) return;
    const onDisk = readSettled(file);
    if (onDisk?.id !== id) return; // not ours any more (or never readable just now): never write over another's
    const tmp = `${file}.${id}.${++n}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`);
    try {
      settled(() => fs.renameSync(tmp, file));
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      throw err;
    }
    record = next;
  }

  /** give the card back; true when a lock of this one's own was removed */
  function release() {
    if (!held) return false;
    held = false;
    record = null;
    const onDisk = readSettled(file);
    if (onDisk?.id !== id) return false;
    try {
      settled(() => fs.unlinkSync(file));
      return true;
    } catch {
      return false;
    }
  }

  return {
    file,
    id,
    get held() {
      return held;
    },
    tryTake,
    acquire,
    setEngines,
    release,
    /** for GET /health: the lock as it is on disk and whether it is this process's */
    status() {
      const lock = readJson(file);
      return { lock, mine: !!lock && lock.id === id };
    },
  };
}
