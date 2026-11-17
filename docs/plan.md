# Chronos Lite: the plan

Chronos Lite is Chronos made smaller on purpose, carved out of the Chronos checkout by a list (`lite/carry.json`) the way Hephaestus Lite was carved out of Hephaestus. It keeps the core that takes a quest and runs it on local brains, and cuts everything that reaches past one computer, one card and one caller.

## What it is

A service on 127.0.0.1:7778 that takes a quest over HTTP and runs it:

- **s**: no plan; one Promethean on the 4B does the whole quest, and a fall splits onto the 0.8B.
- **m**: the 9B plans up to three tasks and judges; Prometheans on the 4B work them; a fall splits onto the 0.8B.
- **l** is not in Lite: a quest that asks for it (in `size`, or `[size:l]` in its first line) runs as m, and the log says so.

Every quest is capped at 25 brain turns and its falls at a split depth of 2. The record of each quest is the chained trail Chronos keeps. The events go out on GET /events, replayed from an in-memory ring with `?since=n`, so a caller that drops and comes back misses nothing while the service runs.

## The caps

`lite/edition.json` holds them and `scripts/check-edition.mjs` asserts them against the code: brains 3, sizes s and m, cards 1, turns 25, split depth 2, tools 8, port 7778, zero dependencies, and the list of what is cut.

## What is cut

The l tier and the 27B, Colibri, media and attachments, chats, reading Hephaestus's record, the bridge and envoys, setup downloads (the installer does that instead), the ledger, the history across restarts, the full UI (face, loom, record), the desktop app, the clock tower and the Mac launcher.

## Living beside full Chronos

Both can run on one computer. Lite listens on 7778 and keeps its engine, brains and logs under `~/.chronos-lite`; its brains listen on 7710, 7720 and 7730, a hundred above full Chronos's, so neither takes the other's ports. The card is one: Lite takes and gives back the same `run/gpu.lock` under the full Chronos home (`CHRONOS_HOME`, else `~/.chronos`), with the same rules, so a GPU start in one waits while the other holds the card and never falls back to the CPU on its own.

Its beacon says kind `chronos-lite`, so a Hephaestus looking for full Chronos never picks it by mistake. Its /health says kind `chronos` with `edition: "lite"`, so the existing Chronos wisp driver works when it is pointed at port 7778.

## The stages

1. **Founded.** The paper: the edition, the brand, the carry list, the plan, the decisions, the build map.
2. **Scaffold.** package.json, the edition check, the sync check, CI on Linux and macOS.
3. **The core carried.** The runtime copied from Chronos and cut at its seams; its tests on the Lite shape.
4. **Install.** `scripts/install.sh`: the engine and the three brains into `~/.chronos-lite`, checked by sha256; a doctor; a short guide.
5. **The first live run.** A size s and a size m quest on a real card beside a running full Chronos, the card lock proved between them.
6. **A slim UI.** A page or two written fresh: the queue, a quest's events, its report.

## Contracts kept with Chronos

The event shape (`{n, t, type, ...}`), the quest routes and their answers, the card lock file and its rules, and the trail's chain are the same as full Chronos's, so a caller written for Chronos reads Lite unchanged.
