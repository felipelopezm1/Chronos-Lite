// The trail: one entry per quest under brain/docs-trail/<date>-<slug>.md, in
// Hephaestus's shape (front matter with title, date, prev, hash) and chained:
// hash = sha256(prev + body), prev = the hash of the entry before it. The
// genesis entry has prev "" and hash "", so the first real entry's prev is "".

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function trailDir(root) {
  return path.join(root, "brain", "docs-trail");
}

export function slugify(text, max = 48) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "quest"
  );
}

export function hashEntry(prev, body) {
  return createHash("sha256").update(`${prev ?? ""}${body}`).digest("hex");
}

/**
 * Front matter and body of one entry file; null when it has no front matter.
 * The front matter may end its lines with CRLF (an entry saved by a Windows
 * editor); the body is kept byte for byte, since the hash is over it.
 */
export function parseEntry(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Every entry with front matter, in file order, with its path. */
export function readChain(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const file = path.join(dir, name);
    const e = parseEntry(readFileSync(file, "utf8"));
    if (e) out.push({ file, name, ...e });
  }
  return out;
}

/** The hash the next entry chains from: the last entry's hash, "" at genesis. */
export function lastHash(dir) {
  const chain = readChain(dir);
  return chain.length ? chain.at(-1).meta.hash ?? "" : "";
}

/**
 * Check every link: each entry's prev is the hash before it and its hash is
 * sha256(prev + body). Genesis (hash "") is the anchor and is not recomputed.
 */
export function verifyChain(dir) {
  const chain = readChain(dir);
  const broken = [];
  let prev = "";
  for (const e of chain) {
    const { hash = "", prev: p = "" } = e.meta;
    if (hash === "" && p === "") {
      prev = "";
      continue;
    }
    if (p !== prev) broken.push({ name: e.name, why: `prev is ${p.slice(0, 8) || '""'}, expected ${prev.slice(0, 8) || '""'}` });
    else if (hash !== hashEntry(p, e.body)) broken.push({ name: e.name, why: "hash does not match the body" });
    prev = hash;
  }
  return { ok: broken.length === 0, entries: chain.length, broken };
}

/**
 * Write one entry. Returns { file, hash, prev }. The file name is
 * <date>-<slug>.md; a clash gets a counter.
 */
export function writeTrail({ root, dir = trailDir(root), title, body, date = new Date() }) {
  mkdirSync(dir, { recursive: true });
  const day = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  const prev = lastHash(dir);
  const text = `${body.trim()}\n`;
  const hash = hashEntry(prev, text);
  let name = `${day}-${slugify(title)}.md`;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${day}-${slugify(title)}-${n}.md`;
  const file = path.join(dir, name);
  const front = `---\ntitle: ${JSON.stringify(title)}\ndate: ${day}\nprev: ${JSON.stringify(prev)}\nhash: ${JSON.stringify(hash)}\n---\n`;
  writeFileSync(file, front + text);
  return { file, hash, prev, name };
}


/**
 * A trail entry as the Record lists it: {name, title, date, hash, prev, id,
 * task, by, status, summary}. The quest fields are read from the body trailBody
 * writes (runtime/quests.mjs); an entry that is not a quest (a day's note
 * written by hand) has them null.
 */
export function entryRow(e) {
  const body = e.body ?? "";
  // a field runs from its label to the next label, heading or the closing Titan line: an ask may hold blank lines
  const field = (label) => {
    const at = body.search(new RegExp(`^\\*\\*${label}:\\*\\*`, "m"));
    if (at < 0) return null;
    const rest = body.slice(at + label.length + 5);
    const end = rest.search(/\n\*\*(?:Ask|By|Status|Summary):\*\*|\n## |\nTitan \S+ on /);
    return (end < 0 ? rest : rest.slice(0, end)).trim() || null;
  };
  const id = body.match(/^# Quest (q-[\w-]+)/m)?.[1] ?? null;
  const span = body.match(/; (\S+) to (\S+)\.\s*$/);
  const startedAt = span ? Date.parse(span[1]) : NaN;
  const endedAt = span ? Date.parse(span[2]) : NaN;
  return {
    name: e.name,
    title: e.meta?.title ?? e.name,
    date: e.meta?.date ?? e.name.slice(0, 10),
    hash: e.meta?.hash ?? "",
    prev: e.meta?.prev ?? "",
    id,
    task: field("Ask"),
    by: field("By"),
    status: field("Status"),
    summary: field("Summary"),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
  };
}
