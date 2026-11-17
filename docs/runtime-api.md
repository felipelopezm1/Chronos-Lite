# The runtime API

Everything a caller (the slim UI, Hephaestus's wisp driver, curl) may use, with the shapes it sends and gets back. The service listens on `127.0.0.1:7778` (`CHRONOS_LITE_HOST`, `CHRONOS_LITE_PORT`). It is the code in `runtime/server.mjs`; where this page and the code disagree, the code wins and this page is fixed.

## Rules for every route

- Every answer is JSON (`content-type: application/json`) except `/events` (Server-Sent Events) and the UI's static files.
- An error is `{ "error": "<a sentence>" }` with a 4xx or 5xx status.
- **POST is for this computer only.** A POST whose `Origin` header is not a localhost page (`localhost`, `127.0.0.1`, `[::1]`, any port) is refused with **403**. No `Origin` (curl, a script, another runtime) is allowed. GETs are not checked.
- A trusted page gets CORS headers back: `Access-Control-Allow-Origin: <its origin>`, methods `GET, POST, OPTIONS`, headers `content-type, last-event-id`. `OPTIONS` answers 204 for a trusted origin and 403 for any other.
- A POST body is at most 1 MiB (**413** past it) and must be a JSON object (**400** when it is not JSON).
- Unknown routes answer **404**. The routes full Chronos has and Lite cut (`/brains`, `/chat`, `/media`, `/chats`, `/bridge/*`, `/envoys`, `/log`, `/trail`, `/link`, `/heph`, `/setup`, `/shutdown`) answer 404 too.
- Nothing is kept across a restart: quests and events live in memory.

## GET /health

Who this is and how it stands. Cheap enough to poll every few seconds.

```json
{
  "ok": true,
  "kind": "chronos",
  "edition": "lite",
  "name": "Chronos Lite",
  "builtOn": "built on Chronos",
  "version": "0.1.0",
  "cwd": "/path/to/the/work/folder",
  "code": "/path/to/the/checkout",
  "port": 7778,
  "commit": "4d52f04",
  "brains": [
    { "id": "qwen3.5-9b", "role": "talk", "status": "idle", "slot": "talk", "present": false, "where": null },
    { "id": "qwen3.5-4b", "role": "promethean", "status": "idle", "slot": "promethean", "present": false },
    { "id": "qwen3.5-0.8b", "role": "offspring", "status": "idle", "slot": "offspring", "present": false }
  ],
  "hardware": { "vram": { "totalMiB": 12288, "usedMiB": 900, "freeMiB": 11388, "card": "..." }, "ram": { "totalMiB": 30000, "availableMiB": 20000 }, "cpu": { "threads": 16, "load1": 0.4 }, "heat": { "junctionC": 55, "edgeC": 48, "critC": 100, "cpuC": 60, "hot": false }, "at": 1763380000000 },
  "governor": { "runs": true, "why": null },
  "card": { "lock": null, "mine": false, "stale": false },
  "quests": { "queued": 0, "running": 0 },
  "sizes": {
    "s": { "ok": false, "tier": { "titan": null, "promethean": "qwen3.5-4b", "offspring": "qwen3.5-0.8b", "judge": "qwen3.5-4b" }, "tokens": 16000, "seconds": 900, "maxTasks": 1, "note": "...", "present": { "qwen3.5-4b": false, "qwen3.5-0.8b": false }, "fallsTo": null, "why": "the Promethean brain qwen3.5-4b is not on disk: no smaller size can run either" },
    "m": { "ok": false, "tier": { "titan": "qwen3.5-9b", "promethean": "qwen3.5-4b", "offspring": "qwen3.5-0.8b", "judge": "qwen3.5-9b" }, "tokens": 64000, "seconds": 2700, "maxTasks": 3, "note": "...", "present": { "...": false }, "fallsTo": null, "why": "..." }
  },
  "capabilities": { "hash": "a1b2c3d4e5f6", "url": "/capabilities" },
  "missing": ["brains.mjs"]
}
```

- `kind` is `"chronos"` so a caller written for full Chronos hires Lite unchanged; `edition: "lite"` says which it is.
- `brains[].status` is `idle`, `waiting` (for the card), `loading`, `ready` or `failed`. `present` is whether its file is on disk; `where` is whose copy it runs from: `"lite"` (Lite's home), `"chronos"` (a full Chronos's, reused in place because the installer found it to be the pinned file, docs/install.md) or `null` when it is not there.
- `hardware` is `null` where the hardware sense cannot read this system; any of its numbers may be `null`.
- `card.lock` is the card lock file as it is now: `null` when the card is free, else `{ pid, port, brain, since, host, what, id, engines }`; `mine` is true when this process holds it. `what` is `"chronos-lite"` for Lite. `stale` is true when the lock is another process's and nothing of it runs any more (its process and its engines are gone, on this host): the card is free in practice, and the first GPU start takes the lock over.
- `sizes` holds `s` and `m` only. A size with `ok: false` has `why` and `fallsTo` (the size a quest of it runs as, or `null`).
- `missing` appears only when a module could not load.

## GET /capabilities

What this edition can do. Fetch it again when `/health`'s `capabilities.hash` changes.

```json
{
  "schema": "chronos-lite.capabilities/1",
  "kind": "chronos",
  "edition": "lite",
  "version": "0.1.0",
  "hash": "a1b2c3d4e5f6",
  "name": "Chronos Lite",
  "builtOn": "built on Chronos",
  "commit": "4d52f04",
  "port": 7778,
  "routes": [{ "method": "GET", "path": "/health", "what": "..." }],
  "sizes": { "s": { "...": "as in /health" }, "m": { "...": "as in /health" } },
  "cutSizes": { "l": "m" },
  "caps": { "brains": 3, "sizes": ["s", "m"], "cards": 1, "turns": 25, "splitDepth": 2, "tools": 8 },
  "tools": ["read_file", "write_file", "edit_file", "grep", "glob", "bash", "fetch", "remember"],
  "events": ["quest.queued", "quest.started", "..."],
  "brains": [{ "id": "qwen3.5-9b", "role": "talk", "slot": "talk", "device": null, "present": false, "status": "idle" }],
  "card": { "lock": null, "mine": false, "stale": false },
  "governor": { "runs": true, "why": null },
  "cut": ["l-tier", "27B", "..."],
  "hiredBy": "Hephaestus, as a wisp only: ..."
}
```

## GET /edition

The white label, for a header and an about box. Read once at load.

```json
{
  "name": "Chronos Lite",
  "shortName": "Lite",
  "accent": null,
  "logo": null,
  "builtOn": "built on Chronos",
  "version": "0.3.0",
  "caps": { "brains": 3, "sizes": ["s", "m"], "cards": 1, "turns": 25, "splitDepth": 2, "tools": 8 },
  "vocabulary": "chronos",
  "words": null,
  "avatar": { "kind": "face", "frames": null, "tint": null }
}
```

`accent` is a CSS colour or `null` (use the default); `logo` is a URL path or `null`. `vocabulary` is `chronos` or `plain` (left out of the brand, `plain`); `words` renames any of the page's words, or is `null`; `avatar` is `{kind: "face", frames, tint}` (`frames` a path on this computer or `null`, `tint` `"accent"`, a hex colour or `null`) or `{kind: "monogram"}`. The installer sets them in `lite/brand.json`; the `builtOn` mark must stay visible. [ui.md](ui.md) says what the page does with each.

## POST /quests

Hire a quest.

Request:

```json
{ "task": "Count the stars and write the number to stars.txt", "by": "ui", "size": "auto", "budget": { "tokens": 20000, "seconds": 600 } }
```

- `task` (required): the ask. Its first line may name a size: `[size:s]` anywhere in it, or `size: m` at its start; the marker is taken out of the task.
- `by`: who asks (`"ui"`, `"hephaestus"`, a name). Optional.
- `size`: `"auto"` (default), `"s"`, `"m"`, the words `small`, `medium`, or `"l"` / `"large"`. **An l is accepted and runs as m** (Lite has no l tier). Anything else is 400.
- `budget`: optional caps over the tier's: `tokens` (generated) and `seconds` (running time, waits for a cool card not counted), each a number above 0.
- Header `idempotency-key: <any string>`: a retry with the same key gets the same quest back (`duplicate: true`) instead of a new one. The last 1000 keys are remembered.

Answer **202**:

```json
{ "id": "q-mi3k2a7x0f", "status": "queued", "size": "m", "tier": { "titan": "qwen3.5-9b", "promethean": "qwen3.5-4b", "offspring": "qwen3.5-0.8b", "judge": "qwen3.5-9b" } }
```

With a size l asked, it also carries:

```json
{ "downgraded": { "from": "l", "to": "m" }, "note": "size l is not in Chronos Lite (no l tier, no 27B): the quest runs as size m" }
```

A retry with a known idempotency key answers `{ id, status, size, tier, duplicate: true }`.

Quests run one at a time, oldest first. The size is resolved again when the quest starts: when a size's lead brain is not on disk it falls back to the smaller size, and when no size can run the quest ends `failed` with the reason.

## GET /quests

The quests this run knows, newest first, without their reports. `?limit=` (1 to 200, default 50), `?status=` (one status).

```json
{ "quests": [{ "id": "q-...", "task": "...", "by": "ui", "status": "done", "at": 1763380000000, "size": "m", "tier": { "...": "..." }, "asked": "auto", "summary": "3 reports from 4 agents, 1 split. ..." }], "counts": { "queued": 0, "running": 0 } }
```

A quest's `status` is `queued`, `running`, then one of `done`, `partial`, `blocked`, `failed`, `stopped`. The newest 500 finished quests are kept.

## GET /quests/:id

One quest. 404 when unknown. Its fields: `id, task, by, status, at, size, tier, asked`, and when they apply `downgraded, note, budget, stop`, then once it is finished `summary` and `report`:

```json
{
  "status": "done",
  "summary": "3 reports from 4 agents, 1 split. ...",
  "size": "m",
  "downgraded": { "from": "l", "to": "m" },
  "tier": { "titan": "qwen3.5-9b", "promethean": "qwen3.5-4b", "offspring": "qwen3.5-0.8b", "judge": "qwen3.5-9b" },
  "plan": [{ "task": "...", "finish": "...", "rubric": ["..."] }],
  "titan": { "id": "wisp:ck-...", "brain": "qwen3.5-9b" },
  "reports": [{ "id": "wisp:cp-...", "tier": "promethean", "brain": "qwen3.5-4b", "parent": "wisp:ck-...", "depth": 0, "task": "...", "status": "done", "summary": "...", "verified": ["..."], "inferred": ["..."], "files": ["stars.txt"], "open": [], "caught": [], "blocked": "only when blocked: why" }],
  "judged": [{ "id": "wisp:cp-...", "author": "qwen3.5-4b", "by": "qwen3.5-9b", "score": 0.9, "verdict": "pass", "note": "...", "advisory": false }],
  "splits": 1,
  "why": "only when it was stopped by a cap: which",
  "usage": { "tokens": 1234, "turns": 9, "seconds": 41.2, "waitedSeconds": 0 },
  "caps": { "maxTasks": 3, "tokens": 64000, "seconds": 2700, "turns": 25 },
  "phases": [{ "phase": "plan", "brain": "qwen3.5-9b", "at": "2026-11-17T12:00:00.000Z" }],
  "trail": { "name": "2026-11-17-....md", "file": "...", "hash": "...", "prev": "..." },
  "startedAt": "...",
  "finishedAt": "..."
}
```

The caps every quest carries: **25 brain turns** (every brain call counts, plan, work and judging; the call past the cap is never made and the quest ends `stopped` with `why: "the quest passed its cap of 25 brain turns"`), and a fall split at most **2** deep (a worker that falls at depth 2 is `blocked`).

## POST /quests/:id/stop

No body. A queued quest stops at once: `200 { id, status: "stopped" }` and a `quest.done` with `status: "stopped"`. A running one: `200 { id, status: "running", stopping: true }`; its workers halt between turns and it ends `stopped`. A finished one: `200 { id, status }`. Unknown: 404.

## GET /events

The bus as Server-Sent Events. Each block is

```
id: <n>
data: {"n": <n>, "t": <ms since epoch>, "type": "<dotted.type>", ...payload}

```

with a comment line (`: ping`) every 15 s. On connect it first replays, then streams live:

- `GET /events` replays the whole in-memory ring (the last 2000 kept events).
- `GET /events?since=<n>` (or the `Last-Event-ID: <n>` header a browser's `EventSource` sends when it reconnects) replays only the kept events after `n`.

`n` climbs by one per event from 1 at each start; a restart starts again from 1. `hardware.read` is streamed live but never kept, so it is never replayed.

### Event types and payloads

Every event has `n`, `t` and `type`; the rest is per type. `quest` is a quest id; agent ids are `wisp:ck-...` (the Titan), `wisp:cp-...` (a Promethean), `wisp:co-...` (an Offspring).

| type | payload | when |
| --- | --- | --- |
| `quest.queued` | `id, task, by, size, tier, downgraded?` | a quest is accepted |
| `quest.started` | `id, task, by` | the same moment (what older callers follow) |
| `quest.running` | `id, size, tier, downgraded?, fallback?` | the runner takes it, and again if it falls back a size |
| `quest.phase` | `id, phase ("plan" \| "work" \| "judge"), brain` | each phase begins |
| `agent.spawned` | `id, kind: "wisp", arm: "chronos", vendor: "chronos", tier ("titan" \| "promethean" \| "offspring"), parent, brain, task, depth, quest` | the Titan or a worker starts |
| `agent.split` | `id, children: [id, id], depth, quest, why` | a fallen worker is split in two |
| `agent.done` | `id, status, tier, parent, quest, summary, files?` | an agent ends (`done`, `partial`, `fell`, `blocked`) |
| `quest.done` | `id, status, size, tier, summary, why?, report, trail` | the quest ends; `report` is the same as `GET /quests/:id`'s |
| `log` | `text, quest?, id?, level?, size?, fallback?, auto?, cap?, pace?, junctionC?` | anything said along the way: a size note, a cap, pacing for heat |
| `brain.loading` | `id, port, pid` | a brain's server is starting |
| `brain.waiting` | `id, holder, text` | a GPU start waits for the card another Chronos holds |
| `brain.ready` | `id, port, pid` | it answers |
| `brain.failed` | `id, port, pid, why` | it would not start, or it died |
| `brain.stopped` | `id, port, pid, waited?` | it was stopped |
| `brain.switched` | `slot, id, from, pid` | a slot changed brain |
| `heat.cutoff` | `junctionC, cutoffC, text` | the junction stayed at the cutoff: every brain was stopped |
| `heat.clear` | `junctionC, text` | it cooled: brains may start again |
| `hardware.read` | the `/health` `hardware` object | every 2 s, live only |

A quest's events always come in this order: `quest.queued`, `quest.started`, `quest.running`, then its phases and agents, and last `quest.done`.

## GET / and the UI's files

When the checkout has a `ui/` folder, every GET that is not one of the routes above is a file under it: `/` is `ui/index.html`, `/lib/app.js` is `ui/lib/app.js`. Types by extension (`.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.jpg`, `.gif`, `.webp`, `.ico`, `.woff`, `.woff2`, `.txt`, `.map`; anything else `application/octet-stream`), `cache-control: no-cache`. Nothing outside `ui/` is ever served (`..`, encoded or not, is a 404). With no `ui/` folder, `/` is a 404 that says so. The API routes win over a file of the same name.

## The CLI equivalents

```sh
curl -s localhost:7778/health
curl -s localhost:7778/edition
curl -s -X POST localhost:7778/quests -H 'content-type: application/json' -H 'idempotency-key: k1' -d '{"task":"Count the stars","size":"s","by":"cli"}'
curl -s localhost:7778/quests/q-...
curl -sN 'localhost:7778/events?since=0'
curl -s -X POST localhost:7778/quests/q-.../stop
```
