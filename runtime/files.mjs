// File moves that hold on Windows too.
//
// On Linux and macOS a rename over a file, or of one, simply happens. On
// Windows it answers EPERM, EACCES or EBUSY for a moment while another process
// has either file open without sharing it (an antivirus scan of a file just
// written, the search indexer, Hephaestus reading a beacon). There those codes
// mean "try again shortly", and a few tries 20 ms apart get through; anywhere
// else they are real failures and are thrown at once.

import fs from "node:fs";

/** the codes Windows gives for a moment while another process has the file open or is deleting it */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/** an error that on this system means "the file is in someone's hands just now: look again" */
export function momentary(err, platform = process.platform) {
  return platform === "win32" && BUSY.has(err?.code);
}

/** a short wait that blocks (some of these run from a process's exit handler, where nothing async runs) */
export function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fn(), again up to `tries` times in all while it throws a momentary error,
 * `ms` apart. Anything else, or the last momentary one, is thrown.
 */
export function settled(fn, { platform = process.platform, tries = 5, ms = 20, pause = pauseSync } = {}) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!momentary(err, platform) || i >= tries) throw err;
      pause(ms);
    }
  }
}

/** fs.renameSync(from, to), held through Windows' moment of EPERM, EACCES or EBUSY */
export function renameSettled(from, to, { fsApi = fs, ...opts } = {}) {
  return settled(() => fsApi.renameSync(from, to), opts);
}
