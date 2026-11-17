# 0001: Lite is its own repository, carved out by a list

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Chronos Lite lives in its own public repository (Chronos-Lite on GitHub), not as a branch or an edition flag of Chronos. `lite/carry.json` sorts every Chronos file into keep, reuse, rewrite or never; `npm run sync:check` says when a kept file has drifted.

## Why

The owner asked for it, and it is how Hephaestus Lite was made: its own licence, its own version line and a history that never held personal data.

## What it costs

Kept files can drift from Chronos. The guard is the sync check; a fix to a kept file goes to Chronos first.
