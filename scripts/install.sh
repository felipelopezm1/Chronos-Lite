#!/bin/sh
# Chronos Lite installer: the engine (llama.cpp, the build forge/brains.json pins) and the brains, into Lite's home.
#
#   scripts/install.sh [--dry-run] [--models none|minimal|all] [--prefix DIR] [--no-reuse]
#
# What a full Chronos on this computer already has is used first, in place and read-only: its engine when it is the
# same build for this machine, and each brain file whose size and sha256 are the ones pinned (docs/decisions/0019).
# Anything else is downloaded into Lite's home (~/.chronos-lite, or --prefix, or CHRONOS_LITE_HOME), resumably,
# and checked by sha256 before it is kept. Nothing is written anywhere else, nothing runs with sudo, and nothing in
# the full Chronos home is ever moved, changed or deleted. --dry-run prints every action and touches nothing.
#
#   --models none      the engine only
#   --models minimal   the engine and the 0.8B (size s runs on it, slowly)
#   --models all       the engine and the three brains (the default)
#
# Linux (x64, arm64: the Vulkan build) and macOS (arm64: Metal; x64: CPU). Node 22 or later.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TAB=$(printf '\t')
DRY=0
MODELS=all
PREFIX=
REUSE=1
CATALOGUE=

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
gb() { awk -v b="${1:-0}" 'BEGIN { if (b < 1e9) printf "%.0f MB", b / 1e6; else printf "%.2f GB", b / 1e9 }'; }

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=1 ;;
    --models) [ $# -ge 2 ] || die "--models needs none, minimal or all"; MODELS=$2; shift ;;
    --models=*) MODELS=${1#--models=} ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a folder"; PREFIX=$2; shift ;;
    --prefix=*) PREFIX=${1#--prefix=} ;;
    --no-reuse) REUSE=0 ;;
    --catalogue) [ $# -ge 2 ] || die "--catalogue needs a file"; CATALOGUE=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
case "$MODELS" in none|minimal|all) ;; *) die "--models takes none, minimal or all, not $MODELS" ;; esac

[ "$(id -u)" != 0 ] || die "run it as yourself, not as root: everything goes in your own home and nothing needs sudo"

# ---- the machine ----
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "this installer runs on Linux and macOS (on Windows, use WSL)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "no llama.cpp release build for $(uname -m)" ;;
esac
KEY=$OS-$ARCH

command -v node >/dev/null 2>&1 || die "Node 22 or later is needed (https://nodejs.org, or your package manager)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die "Node 22 or later is needed; this is $(node --version)"

LITE_HOME=${PREFIX:-${CHRONOS_LITE_HOME:-$HOME/.chronos-lite}}
case "$LITE_HOME" in /*) ;; *) LITE_HOME=$(pwd)/$LITE_HOME ;; esac
REUSE_HOME=${CHRONOS_HOME:-$HOME/.chronos}

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else node -e 'const h=require("crypto").createHash("sha256");require("fs").createReadStream(process.argv[1]).on("data",(c)=>h.update(c)).on("end",()=>console.log(h.digest("hex")))' "$1"
  fi
}

say "Chronos Lite installer: $KEY, node $(node --version), models: $MODELS"
say "  home   $LITE_HOME"
if [ "$REUSE" = 1 ]; then say "  reuse  $REUSE_HOME (read-only: used in place, never changed)"; else say "  reuse  off"; fi
[ "$DRY" = 1 ] && say "  dry run: nothing will be downloaded, written or moved"
say ""
say "checking what is here (each candidate file is read once for its sha256)..."

set -- --plan --models "$MODELS" --home "$LITE_HOME" --key "$KEY"
if [ "$REUSE" = 1 ]; then set -- "$@" --reuse-home "$REUSE_HOME"; else set -- "$@" --no-reuse; fi
if [ -n "$CATALOGUE" ]; then set -- "$@" --catalogue "$CATALOGUE"; fi
PLAN=$(node "$ROOT/scripts/doctor.mjs" "$@") || die "could not work out the plan"

# ---- the plan, in words ----
FETCH_BYTES=0
FETCHES=0
say ""
while IFS="$TAB" read -r kind action f1 f2 f3 f4 f5 f6 f7 f8; do
  case "$kind/$action" in
    engine/have) say "engine  have    llama.cpp $f2 in $f1" ;;
    engine/reuse) say "engine  reuse   llama.cpp $f2 in $f1 (the full Chronos engine, in place)" ;;
    engine/fetch) say "engine  fetch   $f4 ($(gb "$f5"), sha256 ${f3%"${f3#????????????}"}...) into $f1"; FETCHES=$((FETCHES + 1)) ;;
    engine/none) say "engine  none    $f2" ;;
    file/have) say "brain   have    $f2 ($f1) in $f3" ;;
    file/reuse) say "brain   reuse   $f2 ($f1) at $f3 (checked: $f4)" ;;
    file/fetch) say "brain   fetch   $f2 ($f1, $(gb "$f6")) into $f3"; FETCHES=$((FETCHES + 1)) ;;
    note/*) say "        note    $action" ;;
    total/fetch) FETCH_BYTES=$f1 ;;
  esac
done <<EOF
$PLAN
EOF
say ""
say "to download: $FETCHES file(s), $(gb "$FETCH_BYTES")"

if [ "$DRY" = 1 ]; then
  say "dry run: done; run without --dry-run to carry it out"
  exit 0
fi

# ---- room on the disk ----
if [ "$FETCH_BYTES" -gt 0 ]; then
  there=$LITE_HOME
  while [ ! -d "$there" ]; do there=$(dirname "$there"); done
  FREE_KB=$(df -Pk "$there" | awk 'NR == 2 { print $4 }')
  NEED_KB=$(awk -v b="$FETCH_BYTES" 'BEGIN { printf "%d", b / 1024 * 1.1 + 1 }')
  [ "$FREE_KB" -ge "$NEED_KB" ] || die "not enough room under $there: $(gb "$((FREE_KB * 1024))") free, $(gb "$FETCH_BYTES") needed"
  command -v curl >/dev/null 2>&1 || die "curl is needed to download"
fi

# fetch URL DEST SHA256 BYTES: a resumable download beside DEST, kept only when its sha256 is the pinned one
fetch() {
  part="$LITE_HOME/downloads/$(basename "$2").part"
  mkdir -p "$LITE_HOME/downloads" "$(dirname "$2")"
  have=$( [ -f "$part" ] && wc -c <"$part" | tr -d ' ' || echo 0)
  if [ "$have" != "$4" ]; then
    curl -fL --retry 5 --retry-delay 5 -C - --progress-bar -o "$part" "$1" </dev/null || die "the download of $1 stopped; run the installer again to resume it"
  fi
  got=$(sha_of "$part")
  if [ "$got" != "$3" ]; then
    rm -f "$part"
    die "$(basename "$2"): sha256 $got is not the pinned $3; the download was removed (run again, or the file changed upstream)"
  fi
  mv "$part" "$2"
}

# ---- carry it out ----
while IFS="$TAB" read -r kind action f1 f2 f3 f4 f5 f6 f7 f8; do
  case "$kind/$action" in
    engine/fetch)
      say "engine: downloading $f4"
      fetch "$f2" "$LITE_HOME/downloads/$f4" "$f3" "$f5"
      tmp="$LITE_HOME/bin/.unpack-$$"
      rm -rf "$tmp" && mkdir -p "$tmp"
      tar -xzf "$LITE_HOME/downloads/$f4" -C "$tmp" </dev/null || die "could not unpack $f4"
      server=$(find "$tmp" -name llama-server -type f | head -n 1)
      [ -n "$server" ] || die "$f4 holds no llama-server"
      [ ! -e "$f1" ] || mv "$f1" "$f1.old-$$"
      mv "$(dirname "$server")" "$f1"
      rm -rf "$tmp" "$LITE_HOME/downloads/$f4"
      printf '{\n  "id": "llama.cpp",\n  "build": "%s",\n  "key": "%s",\n  "asset": "%s",\n  "sha256": "%s"\n}\n' "$f7" "$f8" "$f4" "$f3" >"$f1/chronos-engine.json"
      say "engine: llama.cpp $f7 in $f1"
      ;;
    file/fetch)
      say "brain: downloading $f2 ($(gb "$f6"))"
      fetch "$f4" "$f3" "$f5" "$f6"
      say "brain: $f2 checked and kept in $f3"
      ;;
  esac
done <<EOF
$PLAN
EOF

# ---- keep what was checked, so the runtime finds reused files without reading them again ----
node "$ROOT/scripts/doctor.mjs" "$@" --record >/dev/null || die "could not write $LITE_HOME/reuse.json"

# ---- the launcher, inside the home ----
mkdir -p "$LITE_HOME/bin"
cat >"$LITE_HOME/bin/chronos-lite" <<EOF
#!/bin/sh
# Written by scripts/install.sh: the chronos-lite command of the checkout at $ROOT.
CHRONOS_LITE_HOME=\${CHRONOS_LITE_HOME:-$LITE_HOME} exec node "$ROOT/scripts/chronos-lite.mjs" "\$@"
EOF
chmod 755 "$LITE_HOME/bin/chronos-lite"

if [ "$OS" = linux ] && ! (ldconfig -p 2>/dev/null | grep -q libvulkan) && [ ! -e /usr/lib/libvulkan.so.1 ]; then
  say "note: no Vulkan loader was found; install your system's Vulkan package (libvulkan1 and mesa-vulkan-drivers on Debian and Ubuntu) or the brains run on the CPU"
fi

say ""
set -- --quick --home "$LITE_HOME"
if [ "$REUSE" = 1 ]; then set -- "$@" --reuse-home "$REUSE_HOME"; else set -- "$@" --no-reuse; fi
if [ -n "$CATALOGUE" ]; then set -- "$@" --catalogue "$CATALOGUE"; fi
node "$ROOT/scripts/doctor.mjs" "$@" || true
say ""
say "installed. Start it with: $LITE_HOME/bin/chronos-lite start (add $LITE_HOME/bin to your PATH to type chronos-lite)"
