# 0020: The essence back: the face, the loom and the record

**Date:** 2026-11-17. **Status:** accepted. Supersedes [0018](0018-white-label-ui.md) and the "full UI" line of [0006](0006-slim-ui-later.md).

## The choice

The owner found that the slim UI of 0018 had lost what makes Chronos Chronos, and reversed it. Lite's page is Chronos's own again, cut to what Lite serves:

- **The dock with the face.** `ui/face/face.js` and its eight frames are carried as they are (keep). Her state follows Chronos's order of weight (`ui/mood.js`): held, speaking, thinking, working, listening, done, sleep, idle. Lite has no conversation, so two things stand in: she speaks (stone, mouth moving) what a quest came back with, and a brain that waits for a card another service holds counts as held. A split tears her and she re-forms; a failure hits her with a glitch; a stop jolts her.
- **The views:** now (with an ask box, since there is no chat to hire from), loom, record (the quests and this session's events; no ledger, no trail) and models (from `/health`; no start, stop or seat). Chat, tabs, setup and the link to Hephaestus stay cut.
- **The look:** Chronos's style and views CSS, cut to these views, its colours made into tokens the brand sets, with a light mode. The face and the loom keep a dark stage in both modes.

The white label holds. `/edition` gains three fields, read from `lite/brand.json`:

- `vocabulary`: `chronos` (quest, titan, promethean, offspring, brain, loom, record) or `plain` (task, planner, worker, helper, model, threads, history). The shipped brand says `chronos`; a brand that leaves it out gets `plain`, so a company never shows the runtime's inner names by accident. `words` renames any word on top. Both vocabularies live in one place, `ui/brand.js`.
- `avatar`: `{ kind: "face", frames, tint }` or `{ kind: "monogram" }`. `frames` is a folder the service serves with the same eight file names, so a company can redraw her; `tint` is `accent` or a colour, applied as a hue rotation that leaves her greys grey (the stone stays stone). A monogram shows the logo or initials on the dark stage, its ring reacting to the same states.

## Why

The face and the loom are what an owner recognises as Chronos; the words are its language. Carrying them unchanged where possible (keep) means a fix in Chronos reaches Lite through `npm run sync:check`. A tint by hue rotation, rather than a redraw of the palette inside `face.js`, keeps that file byte for byte Chronos's. Defaulting a brand without a vocabulary to plain words keeps the rule of 0018 that a rebrand never shows another product's inner names.
