# Chronos Lite

A white-label, smaller edition of Chronos: a local-models harness that takes quests over HTTP and runs them on three small brains, one card, two sizes. Smaller on purpose. Read `docs/plan.md` first; where it and the owner disagree, the owner wins.

## One rule holds the size

Anything new either replaces something or takes a slot. The caps live in `lite/edition.json` and `npm test` fails when a change breaks one:

- 3 brains (0.8B Offspring, 4B Promethean, 9B Titan for m), in `forge/brains.json`
- 2 sizes, s and m; a size l (or `[size:l]`) is downgraded to m with a note
- 1 card, behind the same card lock as full Chronos (the full Chronos home's `run/gpu.lock`)
- 25 brain turns a quest, a fall split at most 2 deep
- 8 tools
- port 7778, home `~/.chronos-lite`, zero npm dependencies

Do not add a fourth brain, a size l, a ninth tool or a route outside the six in the edition; make the case in a decision record instead.

## Lite is carved out of Chronos, not forked

`lite/carry.json` sorts every file of Chronos's runtime/, forge/, scripts/, ui/, desktop/ and docs/ into keep, reuse, rewrite or never. `npm run sync:check` compares the keep files with a Chronos checkout (`../chronos` or `CHRONOS_SRC`) and lists drift. A fix to a kept file belongs in Chronos first, then comes here as a copy.

## Nothing personal ships

No `brain/`, no `.hephaestus/`, no keys, no absolute home paths, no names or addresses. The edition check greps the tree for them.

## Every change is versioned and mapped

`version` in `package.json` and `lite/edition.json` move together: minor for a new part or a change to how a quest flows, patch for a fix or docs. A choice someone will later ask about gets a record in `docs/decisions/` (next number, never rewrite an old one). When a change that adds or reshapes a part lands on the default branch, append its stage to `docs/build-map.mjs`, add its parts to `nodes` and its threads to `edges`. Plain words, full sentences, British spelling, no em-dashes.
