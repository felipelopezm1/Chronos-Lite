import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashRefused, createTools, slashed } from "./tools.mjs";

function root(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chronos-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "runtime"), { recursive: true });
  writeFileSync(path.join(dir, "runtime", "alpha.test.mjs"), "needle\n");
  writeFileSync(path.join(dir, "runtime", "beta.test.mjs"), "not here\nneedle again\n");
  writeFileSync(path.join(dir, "runtime", "plain.mjs"), "needle in plain\n");
  return dir;
}

test("glob returns a count first and a structured count", async (t) => {
  const tools = createTools({ root: root(t) });
  const out = await tools.call({ name: "glob", arguments: { path: "runtime", pattern: "*.test.mjs" } });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.text.split("\n")[0], "2 files");
  assert.match(out.text, /runtime\/alpha\.test\.mjs/);
  assert.match(out.text, /runtime\/beta\.test\.mjs/);
});

test("directory listing and grep hits say how many items they hold", async (t) => {
  const tools = createTools({ root: root(t) });
  const listing = await tools.call({ name: "read_file", arguments: { path: "runtime" } });
  assert.equal(listing.ok, true);
  assert.equal(listing.count, 3);
  assert.equal(listing.text.split("\n")[0], "3 entries");

  const hits = await tools.call({ name: "grep", arguments: { path: "runtime", pattern: "needle", glob: "*.test.mjs" } });
  assert.equal(hits.ok, true);
  assert.equal(hits.count, 2);
  assert.equal(hits.text.split("\n")[0], "2 hits");
  assert.match(hits.text, /alpha\.test\.mjs:1/);
  assert.match(hits.text, /beta\.test\.mjs:2/);
});

test("a refused bash command tells the worker how to count instead", async (t) => {
  const dir = root(t);
  assert.equal(bashRefused("echo $(ls runtime/*.test.mjs | wc -l)", dir), "bash: no command substitution; count with glob: its result states the number");
  const tools = createTools({ root: dir });
  const out = await tools.call({ name: "bash", arguments: { command: "echo $(ls runtime/*.test.mjs | wc -l)" } });
  assert.equal(out.ok, false);
  assert.equal(out.text, "error: bash: no command substitution; count with glob: its result states the number");
});

test("paths the tools report use / between the parts on every system, nested folders and written files too", async (t) => {
  assert.equal(slashed("runtime\\sub\\x.mjs", "\\"), "runtime/sub/x.mjs", "Windows' separator becomes /");
  assert.equal(slashed("runtime/sub/x.mjs", "/"), "runtime/sub/x.mjs");
  const dir = root(t);
  mkdirSync(path.join(dir, "runtime", "sub"), { recursive: true });
  writeFileSync(path.join(dir, "runtime", "sub", "deep.mjs"), "needle deep\n");
  const tools = createTools({ root: dir });
  const found = await tools.call({ name: "glob", arguments: { path: "runtime/sub", pattern: "*.mjs" } });
  assert.equal(found.count, 1);
  assert.equal(found.text, "1 file\nruntime/sub/deep.mjs");
  const hits = await tools.call({ name: "grep", arguments: { path: "runtime/sub", pattern: "needle" } });
  assert.equal(hits.text, "1 hit\nruntime/sub/deep.mjs:1: needle deep");
  const one = await tools.call({ name: "grep", arguments: { path: "runtime/sub/deep.mjs", pattern: "deep" } });
  assert.equal(one.text, "1 hit\nruntime/sub/deep.mjs:1: needle deep");
  await tools.call({ name: "write_file", arguments: { path: "notes/a/b.md", content: "x\n" } });
  await tools.call({ name: "edit_file", arguments: { path: "runtime/sub/deep.mjs", find: "deep", replace: "deeper" } });
  assert.deepEqual([...tools.touched].sort(), ["notes/a/b.md", "runtime/sub/deep.mjs"]);
});

test("bash refuses absolute paths outside the project on Windows too: C:\\, \\\\server and Git's /paths", () => {
  const win = { pathApi: path.win32 };
  const root = "C:\\Users\\me\\proj";
  assert.equal(bashRefused("cat C:\\Users\\me\\secret.txt", root, win), "bash: C:\\Users\\me\\secret.txt is outside the project");
  assert.equal(bashRefused("cat D:/elsewhere/x", root, win), "bash: D:/elsewhere/x is outside the project");
  assert.equal(bashRefused("cat \\\\server\\share\\x", root, win), "bash: \\\\server\\share\\x is outside the project");
  assert.equal(bashRefused("cat /etc/passwd", root, win), "bash: /etc/passwd is outside the project");
  assert.equal(bashRefused("cat C:\\Users\\me\\proj\\runtime\\a.mjs", root, win), null, "inside the project");
  assert.equal(bashRefused("cat c:\\users\\ME\\proj\\a.mjs", root, win), null, "Windows paths are not case-sensitive");
  assert.equal(bashRefused("cat C:\\Users\\me\\project2\\a.mjs", root, win), "bash: C:\\Users\\me\\project2\\a.mjs is outside the project", "a neighbour whose name starts the same is outside");
  assert.equal(bashRefused("echo hi > C:\\x.txt", root, win), "bash: no redirects to absolute paths");
  assert.equal(bashRefused("mkdir C:\\Users\\me\\x", root, win), "bash: mkdir only inside the project");
  assert.equal(bashRefused("cat runtime/a.mjs", root, win), null, "relative paths are the project's");
  // and on Linux and macOS, as before
  const posix = { pathApi: path.posix };
  assert.equal(bashRefused("cat /etc/passwd", "/home/me/proj", posix), "bash: /etc/passwd is outside the project");
  assert.equal(bashRefused("cat /home/me/proj/runtime/a.mjs", "/home/me/proj", posix), null);
  assert.equal(bashRefused("cat /home/me/proj2/a.mjs", "/home/me/proj", posix), "bash: /home/me/proj2/a.mjs is outside the project");
  assert.equal(bashRefused("mkdir /home/me/proj/x", "/home/me/proj", posix), "bash: mkdir only inside the project");
});

test("edit_file edits a file with Windows line ends (CRLF) in its own line ends, from a find text written with \\n", async (t) => {
  const dir = root(t);
  writeFileSync(path.join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\n");
  const tools = createTools({ root: dir });
  const out = await tools.call({ name: "edit_file", arguments: { path: "win.txt", find: "two\nthree", replace: "2\n3" } });
  assert.equal(out.ok, true, out.text);
  assert.equal(readFileSync(path.join(dir, "win.txt"), "utf8"), "one\r\n2\r\n3\r\n", "the file keeps CRLF throughout");
  // a file with LF is edited exactly as asked
  writeFileSync(path.join(dir, "unix.txt"), "one\ntwo\n");
  assert.equal((await tools.call({ name: "edit_file", arguments: { path: "unix.txt", find: "one\ntwo", replace: "1\n2" } })).ok, true);
  assert.equal(readFileSync(path.join(dir, "unix.txt"), "utf8"), "1\n2\n");
});
