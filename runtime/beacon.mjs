// The beacon: the small file that lets Hephaestus find Chronos. Hephaestus's
// runtime/cities.mjs reads ~/.hephaestus/runtimes/<port>.json, keeps the ones
// whose pid is alive and whose beat is under 90 s old, and lists them as
// cities. Chronos writes the same shape, plus a kind ("chronos"; Chronos Lite
// says "chronos-lite") so a Hephaestus serving this same folder, or a reader
// looking for full Chronos, never mistakes one for the other, and `capabilities` (the
// hash of GET /capabilities) so a reader knows when to fetch the manifest again.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameSettled } from "./files.mjs";

/** how often the beacon is rewritten; Hephaestus calls it stale after 90 s */
export const BEAT_MS = 30_000;

/** where every runtime on this computer leaves its beacon */
export function defaultDir() {
  return path.join(process.env.HEPHAESTUS_ESTATE_DIR || path.join(os.homedir(), ".hephaestus"), "runtimes");
}

/**
 * The short hash of HEAD in root/.git, read from the files so git need not be
 * installed; null when there is no repository or it cannot be read. A git
 * worktree (an iron) is followed to its own HEAD and the shared branches.
 * A folder with no .git at all answers from its build.json when it has one.
 */
export function readCommit(root) {
  // a staged or installed copy has no .git: its build.json, written beside runtime/, ui/ and forge/, says what it is
  if (!fs.existsSync(path.join(root, ".git"))) return readBuildCommit(root);
  try {
    let git = path.join(root, ".git");
    let common = git;
    // a worktree: .git is a file "gitdir: <the worktree's own folder>", whose HEAD is the
    // worktree's and whose commondir file names the folder that holds the branches
    if (fs.statSync(git).isFile()) {
      const m = fs.readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      git = path.resolve(root, m[1].trim());
      common = git;
      try {
        common = path.resolve(git, fs.readFileSync(path.join(git, "commondir"), "utf8").trim());
      } catch {
        /* a submodule's gitdir holds its own refs */
      }
    }
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null;
    const full = ref ? (readRef(git, ref) ?? readRef(common, ref)) : head;
    return /^[0-9a-f]{40}$/.test(full ?? "") ? full.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** The short hash in root/build.json ({ "version", "commit": "<hash>" }, written when the app is staged); null when there is none. */
export function readBuildCommit(root) {
  try {
    const commit = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"))?.commit;
    return typeof commit === "string" && /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** A branch's hash: its loose file, else its line in packed-refs. */
function readRef(git, ref) {
  try {
    return fs.readFileSync(path.join(git, ref), "utf8").trim();
  } catch {
    /* packed */
  }
  try {
    const packed = fs.readFileSync(path.join(git, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [hash, name] = line.trim().split(/\s+/);
      if (name === ref) return hash;
    }
  } catch {
    /* no packed-refs */
  }
  return null;
}

/**
 * Start writing the beacon: at once, then every BEAT_MS. Returns stop(), which
 * ends the timer and deletes the file. The file is also deleted when the
 * process exits or takes SIGINT or SIGTERM, so a Chronos that died is not a
 * ghost city for the next 90 s.
 */
export function startBeacon({ port, root, id = "chronos", name = "Chronos", kind = "chronos", repo = null, host = "127.0.0.1", dir = defaultDir(), every = BEAT_MS, extra = null } = {}) {
  if (!port) throw new Error("the beacon needs a port");
  const file = path.join(dir, `${port}.json`);
  const startedAt = new Date().toISOString();

  function write() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // extra() adds what changes while Chronos runs: the hash of its capabilities, so Hephaestus refetches
      // GET /capabilities only when it changed (runtime/capabilities.mjs)
      let more = {};
      try {
        more = (typeof extra === "function" ? extra() : extra) ?? {};
      } catch {
        more = {};
      }
      const body = { ...more, pid: process.pid, port, root, id, name, kind, host, repo, commit: readCommit(root), startedAt, beat: Date.now() };
      // written beside, then renamed, so a reader never sees half a file
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      renameSettled(tmp, file);
    } catch {
      /* a read-only home: Chronos is still reachable on its port */
    }
  }

  function remove() {
    try {
      const b = JSON.parse(fs.readFileSync(file, "utf8"));
      if (b.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone, or someone else's */
    }
  }

  write();
  const timer = setInterval(write, every);
  timer.unref?.();

  // on a signal: take the file down, and exit only when nobody else is handling the signal
  const onSignal = (sig) => () => {
    remove();
    if (process.listenerCount(sig) <= 1) process.exit(0);
  };
  const handlers = { exit: remove, SIGINT: onSignal("SIGINT"), SIGTERM: onSignal("SIGTERM") };
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
    remove();
  }

  return Object.assign(stop, { file, write, stop });
}
