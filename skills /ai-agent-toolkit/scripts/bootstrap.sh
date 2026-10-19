#!/usr/bin/env bash
# Bootstrap the toolkit: check prerequisites, download resources, rebuild manifest + skill index.
# Safe to rerun: existing repositories are skipped (use update-toolkit.sh to refresh), config is regenerated.
#
# Usage: scripts/bootstrap.sh [--install-prereqs] [--browser-harness] [--only NAME] [--no-download] [--jobs N]
#   --install-prereqs  install MISSING prerequisites (uv, jq) via Homebrew only; otherwise just report
#   --browser-harness  install/upgrade Browser Harness (Python 3.12 + uv) and generate its skill
#   --only NAME        fetch one entry from config/sources.json
#   --no-download      skip downloads, only check prerequisites and rebuild config
#   --jobs N           parallel downloads (default 6)
# Exit: 0 ok | 1 error | 2 usage | 3 prerequisite missing | 4 some downloads failed
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"

INSTALL_PREREQS=0; BH=0; ONLY=""; DL=1; JOBS=6
while [ $# -gt 0 ]; do case $1 in
  --install-prereqs) INSTALL_PREREQS=1;; --browser-harness) BH=1;; --no-download) DL=0;;
  --only) ONLY=${2:?}; shift;; --jobs) JOBS=${2:?}; shift;;
  -h|--help) sed -n '2,12p' "$0"; exit 0;; *) err "unknown option $1"; exit 2;; esac; shift; done

[ "$(uname -s)" = Darwin ] || warn "not macOS ($(uname -s)): prerequisite auto-install is macOS/Homebrew only"
log "toolkit: $TOOLKIT_DIR"

# --- prerequisites -----------------------------------------------------------
MISSING=()
for t in git node npm python3 uv jq rsync; do
  if have "$t"; then ok "$t: $("$t" --version 2>&1 | head -1)"; else warn "$t: missing"; MISSING+=("$t"); fi
done
have python3.12 && ok "python3.12 present" || warn "python3.12 not on PATH (uv can fetch it for Browser Harness)"
if [ ${#MISSING[@]} -gt 0 ] && [ $INSTALL_PREREQS = 1 ]; then
  have brew || die "Homebrew not found; install ${MISSING[*]} manually (https://brew.sh)" 3
  for t in "${MISSING[@]}"; do
    case $t in uv|jq|git|node|rsync) log "brew install $t"; brew install "$t" >&2 || err "brew install $t failed";; *) warn "no auto-install for $t";; esac
  done
  MISSING=(); for t in git node npm python3 uv jq rsync; do have "$t" || MISSING+=("$t"); done
fi
for t in git jq rsync python3; do have "$t" || die "required tool '$t' missing; rerun with --install-prereqs or install it" 3; done
[ ${#MISSING[@]} -gt 0 ] && warn "optional tools still missing: ${MISSING[*]} (Browser Harness needs uv)"

# --- directories -------------------------------------------------------------
mkdir -p "$REPO_DIR"/{skills,tools,reference-libraries,applications} "$TOOLKIT_DIR"/{reports,local}

# --- downloads ---------------------------------------------------------------
FAILS=0
fetch_entry() {
  local name=$1 repo=$2 cat=$3 mode=$4 paths=$5 dest="$REPO_DIR/$3/$1" sha
  if [ -f "$dest/.source.json" ]; then echo "SKIP $name (already present)"; return 0; fi
  if ! sha=$(fetch_to "$name" "$repo" "$mode" "$paths" "$dest.part" 2>/dev/null); then rm -rf "$dest.part"; echo "FAIL $name"; return 1; fi
  if [ "$mode" = pointer ]; then
    printf 'Pointer only: %s\nURL: https://github.com/%s\nSee config/sources.json for license, install method and security notes.\n' "$name" "$repo" > "$dest.part/POINTER.md"
  fi
  jq -n --arg n "$name" --arg r "$repo" --arg s "$sha" --arg m "$mode" --arg d "$(date -u +%FT%TZ)" \
    '{name:$n,repo:$r,commit:$s,mode:$m,fetched_at:$d}' > "$dest.part/.source.json"
  write_checksums "$dest.part"
  mv "$dest.part" "$dest" && echo "OK   $name @ ${sha:0:9}"
}
if [ $DL = 1 ]; then
  need curl
  log "downloading (shallow/sparse, $JOBS parallel)"
  RES=$(mktemp); trap 'rm -f "$RES"' EXIT
  while IFS=$'\t' read -r name repo cat mode paths; do
    [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
    rm -rf "$REPO_DIR/$cat/$name.part"
    ( fetch_entry "$name" "$repo" "$cat" "$mode" "$paths" >> "$RES" ) &
    while [ "$(jobs -r | wc -l)" -ge "$JOBS" ]; do sleep 0.5; done
  done < <(sources_tsv)
  wait
  sort "$RES" >&2
  FAILS=$(grep -c '^FAIL' "$RES" || true)
fi

# --- Browser Harness (explicit opt-in) ---------------------------------------
if [ $BH = 1 ]; then
  have uv || die "uv required for Browser Harness (rerun with --install-prereqs)" 3
  log "installing Browser Harness (python 3.12 via uv)"
  uv tool install --python 3.12 --upgrade --force browser-harness >&2 || die "browser-harness install failed" 1
  OUT="$REPO_DIR/tools/browser-harness/generated"; mkdir -p "$OUT"
  browser-harness skill > "$OUT/SKILL.md" && ok "generated $OUT/SKILL.md"
  # Recording consent: never enable silently; preserve any existing preference.
  pref=$(browser-harness recordings 2>&1 | head -3 || true)
  if printf '%s' "$pref" | grep -q '(default)'; then
    if [ -t 0 ]; then
      read -r -p "Enable local browser recordings (may capture sensitive page content)? [y/N] " a
      case $a in y|Y) browser-harness recordings enable;; *) browser-harness recordings disable;; esac
    else
      warn "recording preference unset (default). Not changed; run: browser-harness recordings enable|disable"
    fi
  else ok "recording preference preserved: $pref"; fi
  log "health check: run  browser-harness --doctor   (Chrome: chrome://inspect/#remote-debugging)"
fi

# --- config ------------------------------------------------------------------
python3 -I "$DIR/lib/build_config.py" "$TOOLKIT_DIR" || die "config generation failed" 1
[ "$FAILS" -gt 0 ] && { err "$FAILS download(s) failed"; exit 4; }
ok "bootstrap complete"
