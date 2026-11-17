# 0018: A white-label UI, written fresh

**Date:** 2026-11-17. **Status:** superseded by [0020](0020-the-essence-back.md). Builds on [0006](0006-slim-ui-later.md) and [0016](0016-edition-quests-list-and-ui.md).

## The choice

Lite's page is one HTML file, four small ES modules and one stylesheet in `ui/`, written fresh for Lite. Nothing of Chronos's face, loom, record, clock tower, icon, fonts, colours or layout is reused. It looks like a calm business tool: neutral greys, one accent from the brand, the system's own fonts, light and dark.

The brand reaches the page through `GET /edition`: `name`, `shortName`, `accent`, `logo`, `builtOn`, `version`, `caps`, and an optional `words` map. A valid hex accent is the accent in both modes, moved only as far as WCAG AA requires. The runtime's inner names (titan, promethean, offspring, brain, quest, the model ids and the service's own name) never reach the page: they are shown as planner, worker, helper, model, task, a size such as 9B, and the brand's name, and `words` can rename them again for a company.

A zero-dependency mock (`scripts/mock-runtime.mjs`, port 7779) serves the page and scripts a quick task, a thorough task with a split, a dropped event stream and a stop, so the page is built and checked without a card.

`ui/index.html`, `ui/app.js` and `scripts/mock-runtime.mjs` share their names with files of the full Chronos UI, so `lite/carry.json` moves those three from never to rewrite: the names are kept (the service serves `ui/index.html` at `/`), the contents are new.

## Why

A company that rebrands Lite must not ship something that is plainly another product's face. Rewriting the inner names at the edge keeps the runtime's events and routes the same as full Chronos's (the contract in the plan) while the page speaks the company's words. No build step and no network fonts keep the page inside Lite's zero-dependency rule and working offline.
