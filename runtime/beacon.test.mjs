import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBeacon, readCommit } from "./beacon.mjs";

const root = path.resolve(import.meta.dirname, "..");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chronos-beacon-"));
}

test("the beacon is written at once with the Hephaestus shape and kind chronos", () => {
  const dir = tmp();
  const beacon = startBeacon({ port: 7699, root, dir, every: 60_000 });
  try {
    const file = path.join(dir, "7699.json");
    assert.equal(beacon.file, file);
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(b.pid, process.pid);
    assert.equal(b.port, 7699);
    assert.equal(b.root, root);
    assert.equal(b.id, "chronos");
    assert.equal(b.name, "Chronos");
    assert.equal(b.kind, "chronos");
    assert.equal(b.host, "127.0.0.1");
    assert.equal(b.repo, null);
    assert.ok(typeof b.startedAt === "string" && !Number.isNaN(Date.parse(b.startedAt)));
    assert.ok(Date.now() - b.beat < 5000);
    assert.ok(b.commit === null || /^[0-9a-f]{7}$/.test(b.commit));
    assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), "no temp file left");
  } finally {
    beacon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Chronos Lite's beacon names its own kind, so a reader looking for full Chronos never picks it", () => {
  const dir = tmp();
  const beacon = startBeacon({ port: 7698, root, dir, id: "chronos-lite", name: "Chronos Lite", kind: "chronos-lite", every: 60_000 });
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, "7698.json"), "utf8"));
    assert.equal(b.kind, "chronos-lite");
    assert.equal(b.id, "chronos-lite");
    // what extra() adds never overrides the kind
    const again = startBeacon({ port: 7697, root, dir, kind: "chronos-lite", every: 60_000, extra: () => ({ kind: "chronos" }) });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "7697.json"), "utf8")).kind, "chronos-lite");
    again.stop();
  } finally {
    beacon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the beat is rewritten on the timer and stop deletes the file and its listeners", async () => {
  const dir = tmp();
  const sigint = process.listenerCount("SIGINT");
  const exit = process.listenerCount("exit");
  const beacon = startBeacon({ port: 7698, root, dir, every: 30 });
  try {
    const file = path.join(dir, "7698.json");
    const first = JSON.parse(fs.readFileSync(file, "utf8")).beat;
    await new Promise((r) => setTimeout(r, 80));
    const later = JSON.parse(fs.readFileSync(file, "utf8")).beat;
    assert.ok(later > first, "the beat moved");
    assert.equal(process.listenerCount("SIGINT"), sigint + 1);
    beacon.stop();
    assert.ok(!fs.existsSync(file), "the file is gone after stop");
    assert.equal(process.listenerCount("SIGINT"), sigint);
    assert.equal(process.listenerCount("exit"), exit);
    beacon.stop(); // twice is harmless
  } finally {
    beacon.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop leaves another process's beacon alone", () => {
  const dir = tmp();
  const file = path.join(dir, "7697.json");
  fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 7697 }));
  const beacon = startBeacon({ port: 7697, root, dir, every: 60_000 });
  // ours overwrote it; put the other one back as if it had raced us, then stop
  fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 7697 }));
  beacon.stop();
  assert.ok(fs.existsSync(file), "a beacon with another pid is not deleted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readCommit: a git checkout gives a short hash, a plain folder gives null", () => {
  const dir = tmp();
  assert.equal(readCommit(dir), null);
  fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(readCommit(dir), "0123456");
  fs.unlinkSync(path.join(dir, ".git", "refs", "heads", "main"));
  fs.writeFileSync(path.join(dir, ".git", "packed-refs"), "# pack-refs\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/main\n");
  assert.equal(readCommit(dir), "fedcba9");
  fs.rmSync(dir, { recursive: true, force: true });
});


test("readCommit follows a git worktree to its own HEAD and the shared branches", () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-main-"));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-tree-"));
  const gitdir = path.join(main, ".git", "worktrees", "iron");
  fs.mkdirSync(path.join(main, ".git", "refs", "heads", "heph"), { recursive: true });
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(main, ".git", "refs", "heads", "heph", "iron"), `${"ab12cd3".padEnd(40, "0")}\n`);
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/heph/iron\n");
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${gitdir}\n`);
  assert.equal(readCommit(tree), "ab12cd3");

  // a detached worktree carries the hash in its own HEAD
  fs.writeFileSync(path.join(gitdir, "HEAD"), `${"9f8e7d6".padEnd(40, "1")}\n`);
  assert.equal(readCommit(tree), "9f8e7d6");

  // a .git file that points nowhere reads as no commit
  fs.writeFileSync(path.join(tree, ".git"), "not a gitdir line\n");
  assert.equal(readCommit(tree), null);
});

test("readCommit: a staged or installed copy has no .git and answers from its build.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-build-"));
  try {
    assert.equal(readCommit(dir), null, "no .git and no build.json: nothing to say");
    fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ version: "0.1.0", commit: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", builtAt: "2026-11-13T22:00:00.000Z", ref: "", dirty: false }));
    assert.equal(readCommit(dir), "0a1b2c3");
    fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ version: "0.1.0", commit: "0a1b2c3" }));
    assert.equal(readCommit(dir), "0a1b2c3", "a short hash is taken as it is");
    for (const bad of ['{"version":"0.1.0","commit":""}', '{"version":"0.1.0"}', '{"commit":"not a hash"}', "not json"]) {
      fs.writeFileSync(path.join(dir, "build.json"), bad);
      assert.equal(readCommit(dir), null, bad);
    }
    // a checkout's own HEAD wins: build.json is only for a folder with no .git
    fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ commit: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567" }));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "fedcba9876543210fedcba9876543210fedcba98\n");
    assert.equal(readCommit(dir), "fedcba9");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
