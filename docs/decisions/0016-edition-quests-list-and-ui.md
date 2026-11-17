# 0016: GET /edition, GET /quests and the UI's files take three slots

**Date:** 2026-11-17. **Status:** accepted.

## The choice

Beside the six routes of the wisp contract, the service answers GET /edition (the white label and the caps), GET /quests (the queue, newest first, without reports) and serves the static files under `ui/` at `/` when the folder is there. The nine are listed in `lite/edition.json` and checked against `runtime/capabilities.mjs`.

## Why

The slim UI (0006) needs a name and a mark to show, a queue to list, and somewhere to be served from. Each takes a slot under the one rule; none reaches past this service.
