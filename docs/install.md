# Installing Chronos Lite

Linux (x64 and arm64) and macOS (Apple silicon, and Intel on the CPU). Node 22 or later, `curl` and `tar`. Nothing runs with sudo and nothing is written outside Lite's home.

```sh
git clone <this repository> chronos-lite && cd chronos-lite
sh scripts/install.sh --dry-run     # what it would do; touches nothing
sh scripts/install.sh               # do it
~/.chronos-lite/bin/chronos-lite start
```

## What the installer does

1. Reads the machine: the system and the processor (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`) and Node's version. It refuses to run as root.
2. Looks for what a full Chronos on this computer already has, in its home (`CHRONOS_HOME`, else `~/.chronos`):
   - **the engine**: `bin/llama` is reused when it is the build `forge/brains.json` pins (llama.cpp b11669) for this machine, read from its `chronos-engine.json`, or from `llama-server --version` when there is none;
   - **each brain file**: `models/<file>` is reused when its size and sha256 are the ones pinned in `forge/brains.json`. A file that differs is named and left alone.

   A reused file is used where it is, read-only. It is never copied, moved, renamed or deleted, and nothing is ever written in the full Chronos home.
3. Downloads what is still missing into Lite's home (`~/.chronos-lite`, or `--prefix DIR`, or `CHRONOS_LITE_HOME`): the engine's release archive for this machine (Vulkan on Linux, Metal on Apple silicon) and each brain file. Downloads go to `downloads/<name>.part` and resume where they stopped when the installer runs again; a file is kept only when its sha256 is the pinned one, and removed when it is not.
4. Writes `reuse.json` in Lite's home: each file it checked, by path, size, time and sha256, and the engine's folder and build. The runtime reads it to find reused files at start without reading gigabytes again; a file that changed since it was checked is not used.
5. Writes the `chronos-lite` command to `<home>/bin/chronos-lite` and runs the doctor.

## Options

| option | what it does |
| --- | --- |
| `--dry-run` | prints every action (have, reuse, fetch, and every file not used and why) and the total to download; writes, downloads and moves nothing |
| `--models all` | the engine and the three brains (the default; about 10.6 GB when nothing is reused) |
| `--models minimal` | the engine and the 0.8B only (size s runs on it, slowly) |
| `--models none` | the engine only |
| `--prefix DIR` | Lite's home is `DIR` instead of `~/.chronos-lite` (the launcher remembers it) |
| `--no-reuse` | reads nothing from the full Chronos home; everything is downloaded |

`HF_ENDPOINT` names a mirror for the brain files. `npm run install:dry` is `--dry-run`.

## The doctor

```sh
npm run doctor                   # or: chronos-lite doctor
node scripts/doctor.mjs --json   # the same, as JSON
node scripts/doctor.mjs --quick  # sizes only, no sha256 (files reuse.json vouches for still count as checked)
```

It changes nothing. It reports Node's version; the engine (where it was found, which build); each brain file (Lite's own or reused from the full Chronos home, and how it was checked: sha256, reuse.json, or size only); whether the service's port (7778) and the brains' ports (7710, 7720, 7730) are free or who holds them; the card lock (the full Chronos home's `run/gpu.lock`) and who holds it; and the GPU it sees. It exits 0 when Lite can run: Node 22, an engine, at least one brain, and the port free or Lite's own.

## The chronos-lite command

A small command over the HTTP API (`docs/runtime-api.md`):

```sh
chronos-lite start                       # the service in the background; logs in <home>/logs/service.log
chronos-lite status                      # GET /health, in words (--json for the answer itself)
chronos-lite ask "Count the stars" --size s
chronos-lite stop
chronos-lite doctor
```

`ask` posts the task, follows its events and prints the report; Ctrl-C asks the quest to stop. `--port` (or `CHRONOS_LITE_PORT`) points it at another port, such as the mock's 7779 (`npm run mock`).

## Reuse at run time

The service (`npm start`, `chronos-lite start`) looks for each brain in Lite's home, then for the copy in the full Chronos home that `reuse.json` vouches for, and for the engine in Lite's `bin/llama`, then the full Chronos one the record names when it is still the pinned build. `/health` says for each brain whether it is present and `where` it runs from (`lite` or `chronos`). `CHRONOS_LITE_REUSE=0` turns reuse off. When the full Chronos updates or deletes a file, Lite stops using it at once (its size or time no longer match); run the installer again to download Lite's own.

## Removing it

Delete `~/.chronos-lite` (or the `--prefix` folder). Nothing else was written, and the full Chronos is untouched.
