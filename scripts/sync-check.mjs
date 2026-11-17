#!/usr/bin/env node
/**
 * Compare what Lite carried with a Chronos checkout (../chronos, or CHRONOS_SRC), by lite/carry.json:
 *
 *   keep      must be byte for byte the same as Chronos's: a difference is drift (a fix belongs in Chronos first)
 *   reuse     copied then trimmed here, so they differ by design: what is reported is whether Chronos's own
 *             copy changed since it was carried (lite/carried.json keeps its sha256), so the change can be weighed
 *   rewrite   written fresh here: only checked to still exist in Chronos
 *   never     must not be in Lite's tree
 *   unsorted  files in Chronos's runtime, forge, scripts, ui, desktop and docs that carry.json does not sort yet
 *
 *   node scripts/sync-check.mjs            the report; exits 1 when anything drifted or is unsorted
 *   node scripts/sync-check.mjs --record   write lite/carried.json: the sha256 of every keep and reuse file in
 *                                          Chronos now, and its commit (after carrying a change over)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carry = JSON.parse(fs.readFileSync(path.join(here, "lite/carry.json"), "utf8"));
const src = path.resolve(process.env.CHRONOS_SRC || path.join(here, carry.source?.local ?? "../chronos"));
const recordFile = path.join(here, "lite/carried.json");
const record = process.argv.includes("--record");

if (!fs.existsSync(path.join(src, "runtime")) || !fs.existsSync(path.join(src, "forge", "brains.json"))) {
  console.error(`no Chronos checkout at ${src}; set CHRONOS_SRC`);
  process.exit(2);
}
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: src, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse", "--short", "HEAD") ?? "unknown";
console.log(`Chronos at ${src} (${commit})`);

if (record) {
  const files = {};
  for (const e of [...carry.keep, ...carry.reuse]) {
    const f = path.join(src, e.path);
    if (fs.existsSync(f)) files[e.path] = sha(f);
  }
  fs.writeFileSync(recordFile, `${JSON.stringify({ about: "The sha256 of each keep and reuse file in Chronos when it was last carried; scripts/sync-check.mjs --record writes it.", commit, files }, null, 2)}\n`);
  console.log(`recorded ${Object.keys(files).length} files at ${commit} in lite/carried.json`);
  process.exit(0);
}

const carried = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : { files: {} };
const report = { same: [], drift: [], missing: [], changedUpstream: [], unrecorded: [], gone: [], shipped: [] };

for (const e of carry.keep) {
  const theirs = path.join(src, e.path);
  const ours = path.join(here, e.path);
  if (!fs.existsSync(theirs)) report.gone.push(e.path);
  else if (!fs.existsSync(ours)) report.missing.push(e.path);
  else if (sha(theirs) === sha(ours)) report.same.push(e.path);
  else report.drift.push(e.path);
}
for (const e of carry.reuse) {
  const theirs = path.join(src, e.path);
  if (!fs.existsSync(theirs)) report.gone.push(e.path);
  else if (!carried.files[e.path]) report.unrecorded.push(e.path);
  else if (carried.files[e.path] !== sha(theirs)) report.changedUpstream.push(e.path);
  if (!fs.existsSync(path.join(here, e.path))) report.missing.push(e.path);
}
for (const e of carry.rewrite) if (!fs.existsSync(path.join(src, e.path))) report.gone.push(e.path);
for (const e of carry.never) if (fs.existsSync(path.join(here, e.path))) report.shipped.push(e.path);

// files in Chronos that carry.json does not sort
const listed = (git("ls-files", "runtime", "forge", "scripts", "ui", "desktop", "docs") ?? "").split("\n").filter(Boolean);
const sorted = new Set([...carry.keep, ...carry.reuse, ...carry.rewrite, ...carry.never].map((e) => e.path));
const unsorted = listed.filter((f) => !sorted.has(f));

const line = (label, list) => list.length && console.log(`${label} (${list.length}):\n  ${list.join("\n  ")}`);
console.log(`keep: ${report.same.length} the same as Chronos's`);
line("DRIFT: keep files that differ from Chronos's", report.drift);
line("MISSING from Lite", report.missing);
line("changed in Chronos since carried (reuse: weigh the change, then --record)", report.changedUpstream);
line("reuse files with no record yet (run --record)", report.unrecorded);
line("GONE from Chronos", report.gone);
line("SHIPPED though carry.json says never", report.shipped);
line("UNSORTED: in Chronos, not in lite/carry.json", unsorted);
const bad = report.drift.length + report.missing.length + report.shipped.length + unsorted.length;
console.log(bad ? `sync check: ${bad} to look at` : "sync check: Lite is in step with Chronos");
process.exit(bad ? 1 : 0);
