# 0015: The quests work under the home

**Date:** 2026-11-17. **Status:** accepted.

## The choice

The quests' file tools read and write, and the trail is kept, in `<home>/work` (`~/.chronos-lite/work`), or `CHRONOS_LITE_WORKDIR`. Full Chronos uses its own code folder when no work folder is named.

## Why

Lite is a white-label service installed for someone else. A quest hired by a caller should never write into the program's own checkout.
