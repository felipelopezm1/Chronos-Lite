# 0010: Its own home

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Lite keeps its engine, brains, logs and trail runs under `~/.chronos-lite` (`CHRONOS_LITE_HOME`; `%LOCALAPPDATA%\ChronosLite` on Windows), picked the way Chronos picks `~/.chronos`. Only the card lock lives outside it (0009).

## Why

So installing, removing or breaking Lite never touches a full Chronos's files. The cost is that the brains are downloaded twice when both are installed; sharing them is an open question for stage 4.
