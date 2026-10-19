#!/usr/bin/env bash
# Audit the sources: URL reachable, upstream HEAD vs recorded commit, license presence,
# deprecation hints, install-script risks, duplicate skill names. Writes reports/REPOSITORY_AUDIT.md.
# Usage: scripts/audit-repositories.sh [--offline]
# Exit: 0 clean | 1 error | 4 findings (warnings) present
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"
need jq; OFFLINE=0; [ "${1:-}" = --offline ] && OFFLINE=1
OUT="$TOOLKIT_DIR/reports/REPOSITORY_AUDIT.md"; W=0
{ echo "# Repository audit ($(date -u +%F))"; echo; echo "| repo | url | upstream vs local | license | notes |"; echo "|---|---|---|---|---|"; } > "$OUT"
while IFS=$'\t' read -r name repo cat mode paths; do
  dest="$REPO_DIR/$cat/$name"; notes=(); url="https://github.com/$repo"
  if [ $OFFLINE = 0 ]; then
    up=$(GIT_TERMINAL_PROMPT=0 git ls-remote "$url.git" HEAD 2>/dev/null | cut -f1 | head -1)
    [ -n "$up" ] && urlst=reachable || { urlst=UNREACHABLE; notes+=("url not reachable"); }
  else up=""; urlst=skipped; fi
  loc=$( [ -f "$dest/.source.json" ] && jq -r .commit "$dest/.source.json" || echo none )
  [ "$loc" = none ] && notes+=("not downloaded")
  [ -n "$up" ] && [ "$loc" != none ] && [ "$up" != "$loc" ] && notes+=("upstream moved: run update-toolkit.sh")
  lic=$(jq -r --arg n "$name" '.[]|select(.name==$n)|.license' "$SOURCES_JSON")
  if [ -n "$(find "$dest" -maxdepth 1 \( -iname "LICEN[SC]E*" -o -iname "COPYING*" \) 2>/dev/null | head -1)" ]; then lst="$lic (file retained)"; else lst="$lic (no file retained)"; notes+=("license file not retained locally"); fi
  if [ -d "$dest" ]; then
    grep -rIlE 'curl[^|]*\|[[:space:]]*(ba)?sh|wget[^|]*\|[[:space:]]*(ba)?sh' "$dest" 2>/dev/null | head -2 | sed "s#$TOOLKIT_DIR/##" | while read -r f; do echo "$f" >> "$OUT.risk"; done
    grep -rIliE 'deprecated|no longer maintained|archived' "$dest"/README.md >/dev/null 2>&1 && notes+=("README mentions deprecated/archived: review")
  fi
  [ ${#notes[@]} -gt 0 ] && W=$((W+1))
  echo "| $name | $urlst | ${up:0:7} vs ${loc:0:7} | $lst | $(IFS=';'; echo "${notes[*]:-ok}") |" >> "$OUT"
done < <(sources_tsv)
{ echo; echo "## Install-script risks (pipe-to-shell patterns found in retained files; review before running anything)";
  if [ -s "$OUT.risk" ]; then sed 's/^/- /' "$OUT.risk" | sort -u; else echo "- none found"; fi; rm -f "$OUT.risk";
  echo; echo "## Duplicate skill registrations (same skill name from more than one source)";
  d=$(jq -r '.skills|group_by(.name)|map(select(length>1))|.[]|"- \(.[0].name): \([.[].source]|join(", "))"' "$TOOLKIT_DIR/config/skill-index.json"); [ -n "$d" ] && echo "$d" || echo "- none"; } >> "$OUT"
log "wrote $OUT ($W repo(s) with notes)"
[ $W -gt 0 ] && exit 4 || exit 0
