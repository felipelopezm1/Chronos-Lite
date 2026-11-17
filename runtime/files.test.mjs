import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { momentary, pauseSync, renameSettled, settled } from "./files.mjs";

const busy = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test("momentary: EPERM, EACCES and EBUSY are Windows' moment of someone else's hands; nothing is, anywhere else", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    assert.equal(momentary(busy(code), "win32"), true, code);
    assert.equal(momentary(busy(code), "linux"), false, code);
    assert.equal(momentary(busy(code), "darwin"), false, code);
  }
  assert.equal(momentary(busy("ENOENT"), "win32"), false);
  assert.equal(momentary(undefined, "win32"), false);
});

test("settled: on Windows a momentary failure is tried again after a short pause, up to five tries; elsewhere it is thrown at once", () => {
  const pauses = [];
  let calls = 0;
  const flaky = (fails, code = "EPERM") => () => {
    calls++;
    if (calls <= fails) throw busy(code);
    return "done";
  };
  assert.equal(settled(flaky(3), { platform: "win32", pause: (ms) => pauses.push(ms) }), "done");
  assert.deepEqual(pauses, [20, 20, 20]);

  calls = 0;
  pauses.length = 0;
  assert.throws(() => settled(flaky(9, "EBUSY"), { platform: "win32", pause: (ms) => pauses.push(ms) }), (err) => err.code === "EBUSY");
  assert.equal(calls, 5, "five tries in all");
  assert.equal(pauses.length, 4);

  for (const platform of ["linux", "darwin"]) {
    calls = 0;
    assert.throws(() => settled(flaky(1), { platform, pause: () => assert.fail("no pause off Windows") }), (err) => err.code === "EPERM");
    assert.equal(calls, 1);
  }
  calls = 0;
  assert.throws(() => settled(flaky(1, "ENOENT"), { platform: "win32", pause: () => assert.fail("ENOENT is no moment") }), (err) => err.code === "ENOENT");
});

test("renameSettled moves a file over another on this system, and holds through Windows' moment", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, "a.json.tmp");
  const to = path.join(dir, "a.json");
  fs.writeFileSync(to, "old\n");
  fs.writeFileSync(from, "new\n");
  renameSettled(from, to);
  assert.equal(fs.readFileSync(to, "utf8"), "new\n");
  assert.equal(fs.existsSync(from), false);

  // the same move with the target in an antivirus's hands for two looks
  fs.writeFileSync(from, "newer\n");
  let refused = 2;
  const fsApi = { renameSync: (a, b) => (refused-- > 0 ? (() => { throw busy("EACCES"); })() : fs.renameSync(a, b)) };
  renameSettled(from, to, { fsApi, platform: "win32", pause: () => {} });
  assert.equal(fs.readFileSync(to, "utf8"), "newer\n");
});

test("pauseSync waits about as long as it is asked, in place", () => {
  const t0 = Date.now();
  pauseSync(30);
  assert.ok(Date.now() - t0 >= 25);
});
