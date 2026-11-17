# 0019: Reuse a full Chronos's engine and brains in place, by sha256

**Date:** 2026-11-17. **Status:** accepted. Answers the open question of [0010](0010-own-home.md).

## The choice

The installer (`scripts/install.sh`) looks in the full Chronos home (`CHRONOS_HOME`, else `~/.chronos`) before it downloads anything:

- a brain file in its `models/` is used when its size and sha256 are the ones `forge/brains.json` pins;
- its `bin/llama` engine is used when it is the pinned llama.cpp build (b11669) for this machine, read from `chronos-engine.json` or from `llama-server --version`.

A reused file is used where it is, read-only: it is never copied, moved, renamed or deleted, and Lite never writes in the full Chronos home. Whatever is not reused is downloaded into Lite's own home, resumably, and kept only when its sha256 is the pinned one.

What was checked is kept in `<Lite home>/reuse.json` (path, size, modification time, sha256). The runtime (`runtime/models.mjs`, used by `runtime/brains.mjs`) uses a reused file only while that record still matches it, so it never hashes at start and never runs a file the full Chronos has since changed. A brains module given only a home (a test) reuses nothing, the same rule as the card lock's (0013). `CHRONOS_LITE_REUSE=0` and `--no-reuse` turn reuse off.

The installer is POSIX sh with Node for the plan (`scripts/doctor.mjs --plan`), so the reuse rules live in one tested module. A small `chronos-lite` command (`scripts/chronos-lite.mjs`: start, stop, status, doctor, ask) speaks only the HTTP API; it is written fresh and is not the full Chronos CLI, which stays cut.

## Why

The three brains and the engine are about 10.6 GB, and a computer that runs Lite beside a full Chronos already has the same files, pinned by the same sha256. Pinning by sha256 makes a reused file exactly the file Lite would have downloaded. Using it in place, and never writing there, keeps 0010's promise that installing, removing or breaking Lite never touches a full Chronos's files; the cost is that when the full Chronos deletes or replaces a file, Lite stops using it until the installer runs again.
