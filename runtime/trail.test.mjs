import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashEntry, parseEntry, verifyChain } from "./trail.mjs";

test("parseEntry reads front matter with LF or CRLF line ends, and keeps the body byte for byte", () => {
  const lf = parseEntry('---\ntitle: "a quest"\ndate: 2026-11-15\n---\nbody\n');
  assert.deepEqual(lf, { meta: { title: "a quest", date: "2026-11-15" }, body: "body\n" });
  const crlf = parseEntry('---\r\ntitle: "a quest"\r\ndate: 2026-11-15\r\n---\r\nbody\r\n');
  assert.deepEqual(crlf, { meta: { title: "a quest", date: "2026-11-15" }, body: "body\r\n" }, "an entry saved by a Windows editor is still an entry");
  assert.equal(parseEntry("no front matter\n"), null);
});

test("an entry whose front matter a Windows editor saved with CRLF stays in the chain and still verifies", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chronos-trail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "2026-01-01-genesis.md"), '---\ntitle: "genesis"\nprev: ""\nhash: ""\n---\nthe start\n');
  const body = "what the quest did\n";
  const hash = hashEntry("", body);
  writeFileSync(path.join(dir, "2026-01-02-quest.md"), `---\r\ntitle: "a quest"\r\nprev: ""\r\nhash: ${hash}\r\n---\r\n${body}`);
  assert.deepEqual(verifyChain(dir), { ok: true, entries: 2, broken: [] });
});
