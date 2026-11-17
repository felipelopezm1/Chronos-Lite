# 0014: Events in a ring, not a ledger

**Date:** 2026-11-17. **Status:** accepted.

## The choice

`runtime/bus.mjs` keeps the last 2000 events in memory and numbers them from 1 at each start; GET /events?since=n replays from that ring. The import of the ledger is cut. `hardware.read`, every 2 s, is streamed and heard (the heat watchdog listens to it) but never kept.

## Why

Lite has no ledger (0005). Kept, the hardware readings alone would push a quest's events out of the ring in about an hour, and a caller that reconnects with `since` would find them gone.

## What it costs

A restart forgets: the numbers start again from 1, and a caller holding an n from before must read the quest's state from GET /quests/:id instead.
