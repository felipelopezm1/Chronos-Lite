# 0009: The same card lock as Chronos

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Lite carries `runtime/cardlock.mjs` unchanged and points it at the full Chronos home: `<CHRONOS_HOME or ~/.chronos>/run/gpu.lock`, not its own. A GPU start takes that lock, waits while another live Chronos holds it (10 minutes by default, `CHRONOS_GPU_WAIT_MS`) and then fails; it never moves to the CPU on its own. The lock is given back when Lite's last GPU brain stops.

## Why

Two runtimes on one card took the junction to 99 C on 2026-11-14. The lock only works if every runtime reads the same file, so Lite's own home cannot hold it.
