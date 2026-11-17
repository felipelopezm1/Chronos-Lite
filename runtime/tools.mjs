// The Promethean tools: what a worker on a small brain may do to the project.
// Each tool is an OpenAI tool schema (for llama-server's --jinja tool calling)
// plus an executor. Every call goes through validate() first: an unknown
// tool, a missing or wrong-typed argument, or a path outside the project
// comes back as an error string the model reads once before it tries again.
//
//   read_file   { path, from?, lines? }       the file, line-numbered
//   write_file  { path, content }              the whole file (folders made)
//   edit_file   { path, find, replace }        exact string replace, once
//   grep        { pattern, path?, glob? }      lines that match, at most 200
//   glob        { pattern, path? }             files that match, at most 500
//   bash        { command }                    an allow-listed command, cwd pinned, 60 s
//   fetch       { url }                        an http(s) GET, 200 KB
//   remember    { text, subject?, kind? }      one claim into brain/memory/chronos.jsonl

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

export const BASH_TIMEOUT_MS = 60_000;
export const BASH_OUTPUT_MAX = 24 * 1024;
export const FETCH_MAX = 200 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const READ_MAX_LINES = 400;
export const GREP_MAX = 200;
export const GLOB_MAX = 500;

/** the commands bash may run; git only with status, diff or log */
export const BASH_ALLOWED = new Set(["ls", "cat", "head", "tail", "grep", "find", "wc", "sed", "awk", "node", "npm", "python3", "git", "echo", "pwd", "true", "mkdir", "bash"]);
const GIT_ALLOWED = new Set(["status", "diff", "log"]);

/** The tools as OpenAI schemas. */
export const TOOL_SCHEMAS = [
  tool("read_file", "Read a file in the project, line-numbered. Use from and lines for a slice of a long file.", {
    path: { type: "string", description: "path relative to the project root" },
    from: { type: "integer", description: "first line to read (1-based)" },
    lines: { type: "integer", description: "how many lines" },
  }, ["path"]),
  tool("write_file", "Write a whole file in the project (its folders are made). Overwrites.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  tool("edit_file", "Replace one exact string in a file with another. The find text must appear exactly once.", {
    path: { type: "string" },
    find: { type: "string" },
    replace: { type: "string" },
  }, ["path", "find", "replace"]),
  tool("grep", "Lines in the project that match a regular expression.", {
    pattern: { type: "string" },
    path: { type: "string", description: "a folder or file to search, the project by default" },
    glob: { type: "string", description: "only files whose name matches, e.g. *.mjs" },
  }, ["pattern"]),
  tool("glob", "Files whose path matches a glob, e.g. runtime/*.mjs or **/*.md.", {
    pattern: { type: "string" },
    path: { type: "string" },
  }, ["pattern"]),
  tool("bash", `Run one shell command in the project (allowed: ${[...BASH_ALLOWED].join(" ")} and the project's scripts/; git only status, diff, log). 60 seconds, output capped.`, {
    command: { type: "string" },
  }, ["command"]),
  tool("fetch", "GET an http or https URL and read its text (200 KB at most).", {
    url: { type: "string" },
  }, ["url"]),
  tool("remember", "Keep one durable claim in brain/memory for later quests.", {
    text: { type: "string" },
    subject: { type: "string" },
    kind: { type: "string", description: "fact, lesson, decision, preference, note" },
  }, ["text"]),
];

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

const SCHEMA_BY_NAME = new Map(TOOL_SCHEMAS.map((t) => [t.function.name, t.function]));

/** Every tool name. */
export const TOOL_NAMES = [...SCHEMA_BY_NAME.keys()];

/**
 * A path relative to the project as the model reads and writes it: "/" between
 * the parts on every system (path.relative gives "\\" on Windows).
 */
export function slashed(rel, sep = path.sep) {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** an absolute path on any of the three systems: /x, C:\x or C:/x, \\server\share */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Resolve a project path and refuse one that leaves the project. Returns the
 * absolute path, or throws with the reason.
 */
export function insideProject(root, p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("the path is empty");
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`the path ${p} is outside the project`);
  return abs;
}

/**
 * Check one call against its schema. Returns { ok: true, name, args } with
 * the arguments coerced to their types, or { ok: false, error } with a
 * sentence the model gets back.
 */
export function validateCall(call, { root }) {
  const name = call?.name;
  const fn = SCHEMA_BY_NAME.get(name);
  if (!fn) return { ok: false, error: `unknown tool "${name}"; the tools are ${TOOL_NAMES.join(", ")}` };
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { ok: false, error: `the arguments of ${name} are not JSON` };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: `the arguments of ${name} must be an object` };
  const out = {};
  const props = fn.parameters.properties;
  for (const key of fn.parameters.required) {
    if (args[key] === undefined || args[key] === null) return { ok: false, error: `${name} needs "${key}"` };
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) return { ok: false, error: `${name} has no argument "${key}"` };
    if (spec.type === "string") {
      if (typeof value !== "string") return { ok: false, error: `${name}.${key} must be a string` };
      out[key] = value;
    } else if (spec.type === "integer") {
      const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (!Number.isInteger(n)) return { ok: false, error: `${name}.${key} must be an integer` };
      out[key] = n;
    }
  }
  for (const key of ["path"]) {
    if (out[key] !== undefined) {
      try {
        insideProject(root, out[key]);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  }
  if (name === "bash") {
    const why = bashRefused(out.command, root);
    if (why) return { ok: false, error: why };
  }
  if (name === "fetch") {
    try {
      const u = new URL(out.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "fetch takes only http and https" };
    } catch {
      return { ok: false, error: `fetch: "${out.url}" is not a URL` };
    }
  }
  return { ok: true, name, args: out };
}

/**
 * Why a shell command may not run, or null when it may. pathApi is the
 * system's path module (path.win32 or path.posix in a test): an absolute path
 * is refused unless it lies inside the project, C:\ and \\server paths on
 * Windows as much as /etc anywhere.
 */
export function bashRefused(command, root, { pathApi = path } = {}) {
  if (typeof command !== "string" || !command.trim()) return "bash needs a command";
  if (/`|\$\(|<\(|>\(/.test(command)) return "bash: no command substitution; count with glob: its result states the number";
  if (/(^|[^>])>\s*(\/|[A-Za-z]:[\\/]|\\\\)/.test(command)) return "bash: no redirects to absolute paths";
  const outside = (w) => {
    // under a Windows bash (Git's) a /path names Git's own folders or another drive: never the project's C:\ path
    if (pathApi.sep === "\\" && w.startsWith("/")) return true;
    if (!ABSOLUTE.test(w) || !pathApi.isAbsolute(w)) return false;
    const rel = pathApi.relative(root, w);
    return rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel);
  };
  const segments = command.split(/\|\|?|&&|;|\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const words = seg.split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++;
    const cmd = words[i] ?? "";
    const rest = words.slice(i + 1);
    const isScript = /^(\.\/)?scripts\/[\w.-]+$/.test(cmd) && existsSync(path.join(root, cmd));
    if (cmd === "bash" || cmd === "sh") {
      const script = rest[0] ?? "";
      if (!/^(\.\/)?scripts\/[\w.-]+$/.test(script) || !existsSync(path.join(root, script))) return `bash: "${cmd} ${script}" is not a project script`;
      continue;
    }
    if (isScript) continue;
    if (!BASH_ALLOWED.has(cmd)) return `bash: "${cmd}" is not allowed (allowed: ${[...BASH_ALLOWED].join(" ")}, scripts/*)`;
    if (cmd === "git" && !GIT_ALLOWED.has(rest[0])) return `bash: git may only ${[...GIT_ALLOWED].join(", ")}`;
    if (cmd === "npm" && !["test", "run", "ls", "--version", "-v"].includes(rest[0])) return "bash: npm may only test, run or ls";
    if (cmd === "mkdir" && rest.some((w) => w.startsWith("/") || (ABSOLUTE.test(w) && pathApi.isAbsolute(w)))) return "bash: mkdir only inside the project";
    for (const w of rest) if (outside(w)) return `bash: ${w} is outside the project`;
  }
  return null;
}

/** A glob (with * ? and **) as a RegExp over a relative path. */
export function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hephaestus"]);

function* walk(dir, rel = "") {
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (SKIP_DIRS.has(d.name)) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) yield* walk(path.join(dir, d.name), r);
    else if (d.isFile()) yield r;
  }
}

function cap(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... (cut at ${max} bytes)` : text;
}

function countedList(items, word, { plural = `${word}s`, empty = `no ${plural}`, capped = false, capAt = null } = {}) {
  const count = items.length;
  const label = `${count} ${count === 1 ? word : plural}`;
  const text = count ? `${label}\n${items.join("\n")}${capped ? `\n... stopped at ${capAt ?? count} ${plural}` : ""}` : `${label}\n${empty}`;
  return { text, count };
}

function resultText(out) {
  return out && typeof out === "object" && typeof out.text === "string" ? out.text : String(out);
}

/**
 * The executors. Each takes validated args and returns a string for the
 * model; a failure is a string too, starting "error:". `touched` collects the
 * files written, for the report.
 */
export function createTools({ root, memoryFile, fetchImpl = globalThis.fetch } = {}) {
  if (!root) throw new Error("tools need a project root");
  root = path.resolve(root);
  memoryFile = memoryFile ?? path.join(root, "brain", "memory", "chronos.jsonl");
  const touched = new Set();

  const run = {
    async read_file({ path: p, from = 1, lines = READ_MAX_LINES }) {
      const abs = insideProject(root, p);
      if (!existsSync(abs)) return `error: ${p} does not exist`;
      if (statSync(abs).isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((d) => !SKIP_DIRS.has(d.name))
          .map((d) => `${d.name}${d.isDirectory() ? "/" : ""}`);
        return countedList(entries, "entry", { plural: "entries", empty: "empty directory" });
      }
      const all = readFileSync(abs, "utf8").split("\n");
      const start = Math.max(1, from);
      const slice = all.slice(start - 1, start - 1 + Math.min(lines, READ_MAX_LINES));
      const body = slice.map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join("\n");
      const more = all.length > start - 1 + slice.length ? `\n... ${all.length - (start - 1 + slice.length)} more lines` : "";
      return cap(body, BASH_OUTPUT_MAX * 2) + more;
    },
    async write_file({ path: p, content }) {
      const abs = insideProject(root, p);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      touched.add(slashed(path.relative(root, abs)));
      return `wrote ${p} (${Buffer.byteLength(content)} bytes)`;
    },
    async edit_file({ path: p, find, replace }) {
      const abs = insideProject(root, p);
      if (!existsSync(abs)) return `error: ${p} does not exist`;
      const text = readFileSync(abs, "utf8");
      // a file with Windows line ends (CRLF) is matched and edited in its own: the model writes "\n"
      const crlf = text.includes("\r\n") && !text.includes(find) && find.includes("\n");
      if (crlf) {
        find = find.replace(/\r?\n/g, "\r\n");
        replace = replace.replace(/\r?\n/g, "\r\n");
      }
      const first = text.indexOf(find);
      if (first < 0) return `error: the find text is not in ${p}`;
      if (text.indexOf(find, first + 1) >= 0) return `error: the find text appears more than once in ${p}; give more context`;
      writeFileSync(abs, text.slice(0, first) + replace + text.slice(first + find.length));
      touched.add(slashed(path.relative(root, abs)));
      return `edited ${p}`;
    },
    async grep({ pattern, path: p = ".", glob }) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        return `error: bad pattern: ${err.message}`;
      }
      const abs = insideProject(root, p);
      if (!existsSync(abs)) return `error: ${p} does not exist`;
      const nameRe = glob ? globToRegExp(glob) : null;
      const files = statSync(abs).isDirectory() ? [...walk(abs, slashed(path.relative(root, abs)))].map((r) => r.replace(/^\.\//, "")) : [slashed(path.relative(root, abs))];
      const hits = [];
      for (const rel of files) {
        if (nameRe && !nameRe.test(path.basename(rel))) continue;
        let text;
        try {
          text = readFileSync(path.join(root, rel), "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < GREP_MAX; i++) if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
        if (hits.length >= GREP_MAX) break;
      }
      const out = countedList(hits, "hit", { empty: "no matches", capped: hits.length >= GREP_MAX, capAt: GREP_MAX });
      return { ...out, text: cap(out.text, BASH_OUTPUT_MAX) };
    },
    async glob({ pattern, path: p = "." }) {
      const abs = insideProject(root, p);
      const base = slashed(path.relative(root, abs));
      const re = globToRegExp(pattern);
      const out = [];
      for (const rel of walk(abs, base)) {
        const inside = base ? rel.slice(base.length + 1) : rel;
        if (re.test(inside) || re.test(rel)) out.push(rel);
        if (out.length >= GLOB_MAX) break;
      }
      return countedList(out, "file", { empty: "no files match", capped: out.length >= GLOB_MAX, capAt: GLOB_MAX });
    },
    async bash({ command }) {
      const why = bashRefused(command, root);
      if (why) return `error: ${why}`;
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", command], { cwd: root, env: { ...process.env, PWD: root }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let cut = false;
        const take = (c) => {
          if (out.length < BASH_OUTPUT_MAX) out += c.toString("utf8");
          else cut = true;
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          out += `\nerror: killed after ${BASH_TIMEOUT_MS / 1000} s`;
        }, BASH_TIMEOUT_MS);
        child.on("error", (err) => {
          clearTimeout(timer);
          if (err?.code === "ENOENT") resolve(`error: there is no bash on this system${process.platform === "win32" ? " (on Windows it comes with Git for Windows)" : ""}; use read_file, grep and glob instead`);
          else resolve(`error: ${err.message}`);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const text = cap(out, BASH_OUTPUT_MAX) + (cut ? "\n... (output cut)" : "");
          resolve(code === 0 ? text || "(no output)" : `${text}\nexit ${code}`);
        });
      });
    },
    async fetch({ url }) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
        const reader = res.body?.getReader?.();
        if (!reader) return cap(await res.text(), FETCH_MAX);
        const chunks = [];
        let size = 0;
        while (size < FETCH_MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
        }
        reader.cancel().catch(() => {});
        const text = Buffer.concat(chunks).toString("utf8");
        return `HTTP ${res.status}\n${cap(text, FETCH_MAX)}`;
      } catch (err) {
        return `error: fetch failed: ${err.message}`;
      }
    },
    async remember({ text, subject = "chronos", kind = "note" }) {
      mkdirSync(path.dirname(memoryFile), { recursive: true });
      appendFileSync(memoryFile, `${JSON.stringify({ t: Date.now(), kind, subject, text })}\n`);
      return "remembered";
    },
  };

  /** Validate then run; never throws: an error is a string the model reads. */
  async function call(c) {
    const v = validateCall(c, { root });
    if (!v.ok) return { ok: false, text: `error: ${v.error}` };
    try {
      const raw = await run[v.name](v.args);
      const text = resultText(raw);
      return { ok: !text.startsWith("error:"), text, ...(Number.isInteger(raw?.count) ? { count: raw.count } : {}), name: v.name, args: v.args };
    } catch (err) {
      return { ok: false, text: `error: ${err?.message ?? err}`, name: v.name, args: v.args };
    }
  }

  return { root, schemas: TOOL_SCHEMAS, validate: (c) => validateCall(c, { root }), run, call, touched };
}
