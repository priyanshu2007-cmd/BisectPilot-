#!/usr/bin/env bash
# Copy selected skills into an agent's native skills directory (real copies, never symlinks).
#
# Usage: scripts/install-skills.sh --agent claude-code|opencode|antigravity|kilo-code|all
#          [--set core,web,...] [--scope project|global] [--project DIR] [--dry-run] [--uninstall] [--force]
#   --set        install sets from config/install-sets.json (default: core)
#   --scope      project (default; DIR/<agent dir>) or global (user-level dir; version dependent, see guides)
#   --project    project root (default: parent folder of the toolkit)
#   --uninstall  remove ONLY skill folders carrying the .toolkit-managed marker
#   --force      overwrite a managed copy that was edited locally (a backup .bak.<ts> is kept)
# 'all' uses a shared layout: .claude/skills (Claude Code) + .agents/skills (OpenCode, Kilo Code, Antigravity).
# Skills are installed under their frontmatter name (OpenCode requires name == folder name).
# Exit: 0 ok | 1 error | 2 usage | 4 some skills skipped
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"
need jq
AGENT=""; SETS=core; SCOPE=project; PROJECT="$(dirname "$TOOLKIT_DIR")"; DRY=0; UNI=0; FORCE=0
while [ $# -gt 0 ]; do case $1 in
  --agent) AGENT=${2:?}; shift;; --set) SETS=${2:?}; shift;; --scope) SCOPE=${2:?}; shift;;
  --project) PROJECT=${2:?}; shift;; --dry-run) DRY=1;; --uninstall) UNI=1;; --force) FORCE=1;;
  -h|--help) sed -n '2,13p' "$0"; exit 0;; *) err "unknown option $1"; exit 2;; esac; shift; done
[ -n "$AGENT" ] || { err "--agent required"; exit 2; }
case $SCOPE in project|global) ;; *) err "bad --scope"; exit 2;; esac

target_dirs() { # agent -> list of skills dirs
  local base
  if [ "$SCOPE" = project ]; then base="$PROJECT"; else base="$HOME"; fi
  case "$1:$SCOPE" in
    claude-code:project) echo "$base/.claude/skills";;     claude-code:global) echo "$base/.claude/skills";;
    opencode:project)    echo "$base/.opencode/skills";;   opencode:global)    echo "$base/.config/opencode/skills";;
    kilo-code:project)   echo "$base/.kilo/skills";;       kilo-code:global)   echo "$base/.kilo/skills";;
    antigravity:project) echo "$base/.agents/skills";;     antigravity:global) echo "$base/.gemini/antigravity/skills";;
    all:*) target_dirs claude-code; if [ "$SCOPE" = project ]; then echo "$base/.agents/skills"; else target_dirs opencode; target_dirs kilo-code; target_dirs antigravity; fi;;
    *) err "unknown agent '$1'"; exit 2;;
  esac
}
[ "$AGENT" = all ] || [ "$AGENT" = claude-code ] || [ "$AGENT" = opencode ] || [ "$AGENT" = antigravity ] || [ "$AGENT" = kilo-code ] || { err "unknown agent '$AGENT'"; exit 2; }
if [ "$AGENT" = antigravity ]; then warn "Antigravity skill paths differ across versions (.agents/skills per current codelab; older docs show .agent/skills); verify in your install"; fi

ids=$(jq -r --arg s "$SETS" '[.sets[($s|split(",")[])]]|add|unique|.[]' "$TOOLKIT_DIR/config/install-sets.json") || { err "bad --set"; exit 2; }
[ -n "$ids" ] || { err "empty set: $SETS"; exit 2; }

dir_hash() { ( cd "$1" && find . -type f ! -name .toolkit-managed -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1 ); }
SKIPPED=0; DONE=0
while IFS= read -r tdir; do
  [ -n "$tdir" ] || continue
  log "target: $tdir"
  while IFS= read -r id; do
    path=$(jq -r --arg id "$id" '.skills[]|select(.id==$id)|.path' "$TOOLKIT_DIR/config/skill-index.json" | head -1)
    [ -n "$path" ] || { warn "$id not in index; skipped"; SKIPPED=$((SKIPPED+1)); continue; }
    src="$TOOLKIT_DIR/$(dirname "$path")"; name=$(jq -r --arg id "$id" '.skills[]|select(.id==$id)|.name' "$TOOLKIT_DIR/config/skill-index.json"|head -1)
    dest="$tdir/$name"
    if [ $UNI = 1 ]; then
      if [ -f "$dest/.toolkit-managed" ]; then [ $DRY = 1 ] && log "would remove $dest" || { rm -r "$dest" && ok "removed $name"; }
      elif [ -e "$dest" ]; then warn "$name not toolkit-managed; left alone"; fi
      continue
    fi
    new=$(dir_hash "$src")
    if [ -e "$dest" ]; then
      if [ ! -f "$dest/.toolkit-managed" ]; then warn "$name exists and is not toolkit-managed; skipped"; SKIPPED=$((SKIPPED+1)); continue; fi
      old=$(cat "$dest/.toolkit-managed"); cur=$(dir_hash "$dest")
      if [ "$cur" = "$new" ]; then log "$name up to date"; continue; fi
      if [ "$cur" != "$old" ] && [ $FORCE = 0 ]; then warn "$name was modified locally; skipped (use --force to back up and replace)"; SKIPPED=$((SKIPPED+1)); continue; fi
      [ $DRY = 1 ] || { [ "$cur" != "$old" ] && mv "$dest" "$dest.bak.$(date +%s)" || rm -r "$dest"; }
    fi
    if [ $DRY = 1 ]; then log "would install $name -> $dest"; continue; fi
    mkdir -p "$tdir" && cp -R "$src" "$dest" && printf '%s\n' "$new" > "$dest/.toolkit-managed" && { ok "installed $name"; DONE=$((DONE+1)); } || { err "failed: $name"; exit 1; }
  done <<< "$ids"
done < <(target_dirs "$AGENT" | sort -u)
log "installed/updated: $DONE, skipped: $SKIPPED"
[ $SKIPPED -gt 0 ] && exit 4 || exit 0
