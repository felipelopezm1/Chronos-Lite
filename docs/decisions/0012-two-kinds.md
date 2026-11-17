# 0012: The beacon says chronos-lite; /health says chronos, edition lite

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Lite's beacon (`~/.hephaestus/runtimes/<port>.json`) has `kind: "chronos-lite"` and `edition: "lite"`. Its GET /health has `kind: "chronos"` and `edition: "lite"`.

## Why

Hephaestus's Chronos wisp driver finds Chronos by a beacon of kind `chronos` and then checks that /health says kind `chronos`. With both Chronos and Lite running, a Lite beacon of kind `chronos` could be picked in full Chronos's place. With /health saying `chronos`, the same driver hires Lite unchanged once it is pointed at port 7778 (its `CHRONOS_PORT`). Hephaestus itself is not changed; a driver that looks for `chronos-lite` beacons is its own later choice.
