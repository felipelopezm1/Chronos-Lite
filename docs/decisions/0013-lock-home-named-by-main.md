# 0013: Only the program names the shared lock home

**Date:** 2026-11-17. **Status:** accepted.

## The choice

The brains module keeps the card lock in the home it is given unless the caller also names `cardHome`. Only `main()` in `runtime/server.mjs` names it, as the full Chronos home (`CHRONOS_HOME`, else `~/.chronos`); with no home at all the module falls back to that shared home too. Every test names only a temp home, so no test reads or writes a real lock.

## Why

0009 puts Lite's lock in the full Chronos home so the two never share the GPU. Defaulting every Brains to that path would let a test (or a second Lite in a test) take the owner's real card lock.
