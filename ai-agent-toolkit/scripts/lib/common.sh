#!/usr/bin/env bash
# Shared helpers. Source, do not execute. Paths are derived from this file's
# location, so the toolkit works wherever it is copied.
# Exit codes used by all scripts: 0 ok | 1 failure | 2 usage | 3 missing prerequisite | 4 partial success

TOOLKIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCES_JSON="$TOOLKIT_DIR/config/sources.json"
REPO_DIR="$TOOLKIT_DIR/repositories"

if [ -t 2 ]; then _c0=$'\033[0m'; _cr=$'\033[31m'; _cg=$'\033[32m'; _cy=$'\033[33m'; else _c0=; _cr=; _cg=; _cy=; fi
log()  { printf '%s\n' "[info] $*" >&2; }
ok()   { printf '%s\n' "${_cg}[ ok ]${_c0} $*" >&2; }
warn() { printf '%s\n' "${_cy}[warn]${_c0} $*" >&2; }
err()  { printf '%s\n' "${_cr}[fail]${_c0} $*" >&2; }
die()  { err "$1"; exit "${2:-1}"; }
have() { command -v "$1" >/dev/null 2>&1; }
need() { have "$1" || die "missing prerequisite: $1" 3; }

# sources_tsv: name<TAB>repo<TAB>category<TAB>mode<TAB>paths(comma-joined)
sources_tsv() {
  jq -r '.[] | [.name,.repo,.category,.mode,(.paths|join(","))] | @tsv' "$SOURCES_JSON"
}

# fetch_to NAME REPO MODE PATHS OUTDIR -> fills OUTDIR with the selected files, prints commit sha.
# Uses shallow, blob-less sparse clones so large repositories are not downloaded in full.
fetch_to() {
  local name=$1 repo=$2 mode=$3 paths=$4 out=$5 tmp sha
  local url="https://github.com/$repo.git"
  mkdir -p "$out"
  if [ "$mode" = pointer ]; then
    sha=$(GIT_TERMINAL_PROMPT=0 git ls-remote "$url" HEAD 2>/dev/null | cut -f1 | head -1)
    [ -n "$sha" ] || return 1
    echo "$sha"; return 0
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/toolkit-fetch.XXXXXX") || return 1
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  if [ "$paths" = "." ]; then
    GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 "$url" "$tmp/r" >&2 || return 1
  else
    GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --filter=blob:none --sparse "$url" "$tmp/r" >&2 || return 1
    { echo '/LICENSE*'; echo '/LICENCE*'; echo '/COPYING*'; echo '/NOTICE*';
      echo "$paths" | tr ',' '\n' | sed 's#^#/#'; } | git -C "$tmp/r" sparse-checkout set --no-cone --stdin >&2 || return 1
  fi
  sha=$(git -C "$tmp/r" rev-parse HEAD)
  # -L turns upstream symlinks into real files (portable copies); exit 23 = dangling links skipped, acceptable
  rsync -aL --exclude '.git' --exclude '*.zip' --exclude node_modules "$tmp/r/" "$out/" 2>/dev/null || [ $? -eq 23 ] || return 1
  echo "$sha"
}

# write_checksums DIR -> DIR/.checksums (sha256 of every file except bookkeeping files)
write_checksums() {
  ( cd "$1" && find . -type f ! -name '.checksums' ! -name '.source.json' -print0 | sort -z | xargs -0 shasum -a 256 > .checksums )
}
