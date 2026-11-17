# Chronos Lite

**A smaller Chronos.** A local-models harness that takes a quest over HTTP, plans it on a 9B brain, works it on a 4B, splits a fall onto a 0.8B, judges the result and keeps a chained record, all on one computer's own card. White-label: a company's name on it, with a small "built on Chronos" mark kept.

"Lite" means smaller, not the light theme.

| | Chronos | Chronos Lite |
| --- | --- | --- |
| brains | six and five alternates | three: 0.8B, 4B, 9B |
| quest sizes | s, m, l | s, m (l runs as m) |
| routes | about 40 | 8 and the UI's files |
| interface | a full UI and a desktop app | none yet (a slim one is planned) |
| dependencies | none | none |

## The caps

Held in [lite/edition.json](lite/edition.json) and checked by `npm test`: 3 brains, sizes s and m, 1 card, 25 brain turns a quest, a fall split at most 2 deep, 8 tools. Anything new replaces something or takes a slot.

## Run it

Node 22 or later, nothing to install.

```sh
npm test                 # the edition check, then every runtime test
npm start                # the service on 127.0.0.1:7778
curl -s localhost:7778/health
npm run sync:check       # compare the carried files with a Chronos checkout (../chronos or CHRONOS_SRC)
```

It answers with no brains on disk; quests then end with the reason. A quest's tools work in `~/.chronos-lite/work` (`CHRONOS_LITE_WORKDIR`). Its home is `~/.chronos-lite` (`CHRONOS_LITE_HOME`), its port 7778 (`CHRONOS_LITE_PORT`), so it sits beside a full Chronos on 7777. The two share one card lock, so they never run on the GPU together.

## How a caller hires it

On this computer only (a POST from a web page that is not on localhost is refused). Every shape is in [docs/runtime-api.md](docs/runtime-api.md).

```
GET  /health              who this is, the brains, the sizes, the card lock, the queue
GET  /capabilities        what this edition can do
GET  /edition             the white label and the caps
POST /quests              {task, by?, size?, budget?} -> 202 {id, size, tier}; an idempotency-key header makes a retry answer the same quest
GET  /quests              the queue, newest first
GET  /quests/:id          its status and report
POST /quests/:id/stop     the workers halt between turns
GET  /events?since=n      what came after n, replayed from memory, then live (Server-Sent Events)
GET  /                    the UI's files, when ui/ is there
```

A Hephaestus hires it as a wisp: post the quest, follow the events, read the report. Its /health says kind `chronos` with edition `lite`, so the Chronos wisp driver hires it when pointed at port 7778. There are no envoys, no outbox and no ledger: a restart forgets.

## Layout

```
runtime/        the service, the runner, the workers, the brains, the senses, the card lock
forge/          brains.json: the three brains and the two tiers
lite/           edition.json (the caps), brand.json (the white label), carry.json (what came from Chronos)
scripts/        check-edition.mjs (npm test), sync-check.mjs
docs/           the plan, the runtime API, the decisions, the build map
```

## Licence

Apache 2.0. See [LICENSE](LICENSE). Chronos Lite is built on Chronos; the engine (llama.cpp) and the brains are separate works with their own licences and are downloaded, never bundled.
