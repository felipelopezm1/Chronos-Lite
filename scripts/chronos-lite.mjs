#!/usr/bin/env node
/**
 * chronos-lite: a small command for the service, over its HTTP API (docs/runtime-api.md). Zero dependencies.
 *
 *   chronos-lite start                 start the service in the background (logs in <home>/logs/service.log)
 *   chronos-lite stop                  stop the one `start` started
 *   chronos-lite status [--json]       GET /health, in words
 *   chronos-lite doctor [...]          scripts/doctor.mjs (--json, --quick)
 *   chronos-lite ask "<task>" [--size s|m] [--json]
 *                                      POST /quests, follow GET /events until it ends, print the report;
 *                                      Ctrl-C asks the quest to stop
 *
 * --port n (or CHRONOS_LITE_PORT) when the service is not on 7778.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liteHome } from "../runtime/platform.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINISHED = new Set(["done", "partial", "blocked", "failed", "stopped"]);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a.startsWith("--") && a.includes("=")) o[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (a === "--size" || a === "--port") o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

/** GET or POST a route; { status, body } with body parsed when it is JSON; null when nothing answers */
export async function call(base, route, { method = "GET", body, headers = {}, timeoutMs = 5000 } = {}) {
  try {
    const r = await fetch(`${base}${route}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed };
  } catch {
    return null;
  }
}

const pidFile = (home) => path.join(home, "run", "chronos-lite.pid");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms, every = 300) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(every);
  }
  return false;
}

async function start({ base, port, home, out }) {
  const h = await call(base, "/health");
  if (h?.status === 200) return out(`already running: ${h.body?.name ?? "Chronos Lite"} on ${base}`), 0;
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const log = fs.openSync(path.join(home, "logs", "service.log"), "a");
  const child = spawn(process.execPath, [path.join(ROOT, "runtime", "server.mjs")], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, CHRONOS_LITE_HOME: home, CHRONOS_LITE_PORT: String(port) } });
  child.unref();
  fs.writeFileSync(pidFile(home), `${child.pid}\n`);
  const up = await waitFor(async () => (await call(base, "/health"))?.status === 200, 20_000);
  if (!up) return out(`it did not answer on ${base} within 20 s; see ${path.join(home, "logs", "service.log")}`), 1;
  out(`started on ${base} (pid ${child.pid}); logs in ${path.join(home, "logs", "service.log")}`);
  return 0;
}

async function stop({ base, home, out }) {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile(home), "utf8").trim()) || null;
  } catch {
    /* not started by start */
  }
  const h = await call(base, "/health");
  if (!pid || !alive(pid)) {
    try { fs.rmSync(pidFile(home)); } catch { /* none */ }
    if (h?.status === 200) return out(`it runs on ${base}, but not as one chronos-lite start began: stop it where it runs`), 1;
    return out("not running"), 0;
  }
  process.kill(pid, "SIGTERM");
  const gone = await waitFor(async () => !alive(pid), 15_000);
  if (!gone) return out(`pid ${pid} did not stop within 15 s`), 1;
  try { fs.rmSync(pidFile(home)); } catch { /* gone already */ }
  out(`stopped (pid ${pid})`);
  return 0;
}

/** /health, in a few lines */
export function describeHealth(h) {
  const lines = [`${h.name ?? "Chronos Lite"} ${h.version ?? ""} on port ${h.port} (${h.builtOn ?? "built on Chronos"})`];
  for (const b of h.brains ?? []) lines.push(`  ${b.id.padEnd(14)} ${String(b.status).padEnd(8)} ${b.present ? `on disk${b.where === "chronos" ? " (the full Chronos copy, reused)" : ""}` : "not on disk"}`);
  for (const [size, s] of Object.entries(h.sizes ?? {})) lines.push(`  size ${size}: ${s.ok ? "ready" : `not ready (${s.why ?? "?"})`}`);
  lines.push(`  card: ${h.card?.lock ? `held by pid ${h.card.lock.pid} (${h.card.lock.what ?? "a Chronos"})` : "free"}; quests: ${h.quests?.queued ?? 0} queued, ${h.quests?.running ?? 0} running`);
  return lines.join("\n");
}

async function status({ base, json, out }) {
  const h = await call(base, "/health");
  if (!h) return out(json ? JSON.stringify({ ok: false, running: false, url: base }) : `not running on ${base}`), 1;
  out(json ? JSON.stringify(h.body, null, 2) : describeHealth(h.body));
  return 0;
}

/** read Server-Sent Events from a fetch response, calling on(event) for each data block */
async function readEvents(res, on) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        if ((await on(JSON.parse(data))) === false) return;
      } catch {
        /* a block that is not JSON */
      }
    }
  }
}

/** one event of the quest, in words, or null to leave it out */
export function eventLine(e) {
  switch (e.type) {
    case "quest.running": return `running as size ${e.size}${e.fallback ? " (fell back)" : ""}`;
    case "quest.phase": return `${e.phase} on ${e.brain}`;
    case "agent.spawned": return `${e.tier} ${e.id} on ${e.brain}: ${String(e.task ?? "").split("\n")[0].slice(0, 100)}`;
    case "agent.split": return `${e.id} split in two (depth ${e.depth})`;
    case "agent.done": return `${e.id} ${e.status}: ${String(e.summary ?? "").split("\n")[0].slice(0, 140)}`;
    case "log": return e.text ? `note: ${e.text}` : null;
    default: return null;
  }
}

async function ask({ base, task, size, json, out, signal }) {
  if (!task) return out('ask needs a task: chronos-lite ask "<task>" [--size s|m]'), 2;
  const h = await call(base, "/health");
  if (!h) return out(`not running on ${base}: chronos-lite start`), 1;
  const posted = await call(base, "/quests", { method: "POST", body: { task, by: "cli", ...(size ? { size } : {}) }, headers: { "idempotency-key": randomUUID() } });
  if (posted?.status !== 202) return out(`refused: ${posted?.status ?? "no answer"} ${JSON.stringify(posted?.body ?? "")}`), 1;
  const id = posted.body.id;
  if (!json) out(`${id}: size ${posted.body.size}${posted.body.downgraded ? ` (${posted.body.note})` : ""}`);
  const stopper = async () => {
    await call(base, `/quests/${id}/stop`, { method: "POST" });
    if (!json) out(`asked ${id} to stop`);
  };
  signal?.addEventListener("abort", stopper, { once: true });
  let report = null;
  const ctl = new AbortController();
  try {
    const res = await fetch(`${base}/events?since=0`, { signal: ctl.signal });
    await readEvents(res, (e) => {
      const mine = e.id === id || e.quest === id;
      if (!mine) return true;
      if (e.type === "quest.done") {
        report = e.report ?? { id, status: e.status, summary: e.summary };
        return false;
      }
      const line = !json && eventLine(e);
      if (line) out(`  ${line}`);
      return true;
    });
  } catch {
    /* the stream dropped: read the quest instead */
  } finally {
    ctl.abort();
  }
  if (!report) {
    await waitFor(async () => FINISHED.has((report = (await call(base, `/quests/${id}`))?.body)?.status), 24 * 3600_000, 2000);
  }
  if (json) out(JSON.stringify(report, null, 2));
  else {
    out(`${id}: ${report?.status}${report?.why ? ` (${report.why})` : ""}`);
    if (report?.summary) out(report.summary);
    for (const r of report?.reports ?? []) if (r.summary) out(`  - ${r.status}: ${r.summary}${r.files?.length ? ` [${r.files.join(", ")}]` : ""}`);
  }
  return report?.status === "done" ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), { out = (s) => console.log(s), signal } = {}) {
  const o = parseArgs(argv);
  const [cmd, ...rest] = o._;
  const port = Number(o.port ?? process.env.CHRONOS_LITE_PORT) || 7778;
  const base = `http://127.0.0.1:${port}`;
  const home = liteHome();
  switch (cmd) {
    case "start": return start({ base, port, home, out });
    case "stop": return stop({ base, home, out });
    case "status": return status({ base, json: o.json, out });
    case "doctor": return spawnSync(process.execPath, [path.join(ROOT, "scripts", "doctor.mjs"), ...argv.slice(argv.indexOf("doctor") + 1)], { stdio: "inherit" }).status ?? 1;
    case "ask": return ask({ base, task: rest.join(" "), size: o.size, json: o.json, out, signal });
    default:
      out(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 14).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctl = new AbortController();
  process.once("SIGINT", () => ctl.abort());
  main(undefined, { signal: ctl.signal }).then((code) => process.exit(code), (err) => {
    console.error(`chronos-lite: ${err?.message ?? err}`);
    process.exit(2);
  });
}
