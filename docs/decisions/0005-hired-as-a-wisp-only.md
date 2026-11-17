# 0005: Hephaestus hires Lite as a wisp only

**Date:** 2026-11-17. **Status:** accepted.

## The choice

The only way in is POST /quests, and the only way out is GET /events (with `?since=n` replayed from an in-memory ring) and GET /quests/:id. There are no envoys, no bridge, no outbox and no ledger. An idempotency-key header still makes a retried POST answer the same quest.

## Why

A wisp is the one contract Hephaestus already uses for Chronos, and it needs nothing on disk. What is lost: a restart forgets its quests and events, and an answer is never pushed home.
