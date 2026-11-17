# 0003: Two sizes, s and m; no l and no 27B

**Date:** 2026-11-17. **Status:** accepted.

## The choice

A quest is s or m. A quest that asks for l, in `size` or as `[size:l]` in its first line, is accepted and runs as m, with a note on the bus and on the quest (`downgraded`). It is not refused, because a caller written for full Chronos may ask for l.

## Why

The l tier needs the 27B, which is alone on the GPU and runs in three phases with two swaps. That is the slowest, hottest and most fragile path in Chronos, and the one Lite exists to leave out.
