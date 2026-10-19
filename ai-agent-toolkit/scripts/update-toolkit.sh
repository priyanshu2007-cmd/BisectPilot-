#!/usr/bin/env bash
# Check upstream for newer commits and (optionally) apply them without clobbering local edits.
# Default is a dry run: it only lists what would change.
#
# Usage: scripts/update-toolkit.sh [--apply] [--only NAME]
#   --apply   copy new upstream files over the local copy; files you modified locally are kept as-is
#             (detected via .checksums); upstream-deleted files are never removed.
# Exit: 0 ok | 1 error | 2 usage | 4 some repos failed
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"
need git; need jq; need rsync
APPLY=0; ONLY=""
while [ $# -gt 0 ]; do case $1 in --apply) APPLY=1;; --only) ONLY=${2:?}; shift;; -h|--help) sed -n '2,9p' "$0"; exit 0;; *) err "unknown option $1"; exit 2;; esac; shift; done
FAIL=0; CHANGED=0
while IFS=$'\t' read -r name repo cat mode paths; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
  dest="$REPO_DIR/$cat/$name"
  [ -f "$dest/.source.json" ] || { warn "$name: not downloaded (run bootstrap.sh)"; continue; }
  old=$(jq -r .commit "$dest/.source.json")
  new=$(GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$repo.git" HEAD 2>/dev/null | cut -f1 | head -1)
  [ -n "$new" ] || { err "$name: cannot reach upstream"; FAIL=$((FAIL+1)); continue; }
  [ "$old" = "$new" ] && { log "$name: current (${old:0:9})"; continue; }
  CHANGED=$((CHANGED+1)); log "$name: ${old:0:9} -> ${new:0:9}"
  stage=$(mktemp -d "${TMPDIR:-/tmp}/toolkit-up.XXXXXX")
  if ! sha=$(fetch_to "$name" "$repo" "$mode" "$paths" "$stage/new"); then err "$name: fetch failed"; FAIL=$((FAIL+1)); rm -rf "$stage"; continue; fi
  ( cd "$dest" && shasum -a 256 -c .checksums 2>/dev/null | grep -v ': OK$' | sed 's/: FAILED.*//; s#^\./##' ) > "$stage/modified.txt" || true
  [ -s "$stage/modified.txt" ] && warn "$name: $(wc -l < "$stage/modified.txt" | tr -d ' ') locally modified file(s) will be preserved"
  if [ "$mode" != pointer ]; then
    diff -rq --exclude=.source.json --exclude=.checksums --exclude=POINTER.md "$dest" "$stage/new" 2>/dev/null | head -15 | sed 's/^/    /' >&2
  fi
  if [ $APPLY = 1 ]; then
    sed 's#^#/#' "$stage/modified.txt" > "$stage/excl.txt"
    [ "$mode" = pointer ] || rsync -a --exclude-from="$stage/excl.txt" "$stage/new/" "$dest/"
    jq --arg s "$sha" --arg d "$(date -u +%FT%TZ)" '.commit=$s|.fetched_at=$d' "$dest/.source.json" > "$stage/sj" && mv "$stage/sj" "$dest/.source.json"
    # Re-baseline checksums only for files that now match upstream; kept local edits stay flagged as modified.
    ( cd "$dest" && find . -type f ! -name .checksums ! -name .source.json -print0 | sort -z | xargs -0 shasum -a 256 > "$stage/all.sum" )
    if [ -s "$stage/modified.txt" ]; then grep -vFf <(sed 's#^#./#' "$stage/modified.txt") "$stage/all.sum" > "$dest/.checksums"; else cp "$stage/all.sum" "$dest/.checksums"; fi
    ok "$name updated"
  fi
  rm -rf "$stage"
done < <(sources_tsv)
[ $APPLY = 0 ] && [ $CHANGED -gt 0 ] && log "$CHANGED repo(s) have updates; rerun with --apply"
[ $APPLY = 1 ] && python3 -I "$DIR/lib/build_config.py" "$TOOLKIT_DIR"
[ $FAIL -gt 0 ] && exit 4 || exit 0
