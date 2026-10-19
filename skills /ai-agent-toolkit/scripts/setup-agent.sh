#!/usr/bin/env bash
# Add the toolkit entry instruction to an agent's native project instruction file (idempotent, with backup),
# and optionally install the core skills. Existing content is preserved: only a marked block is added/updated.
#
# Usage: scripts/setup-agent.sh --agent claude-code|opencode|antigravity|kilo-code [--project DIR] [--install-skills] [--dry-run] [--remove]
#   claude-code -> DIR/CLAUDE.md     kilo-code, antigravity -> DIR/AGENTS.md (Antigravity's use of AGENTS.md is not confirmed by its docs;
#   its verified mechanism is skill discovery, so also use --install-skills)
#   opencode -> DIR/AGENTS.md, or DIR/CLAUDE.md when only that exists (OpenCode reads the first of the two, so a new AGENTS.md would hide CLAUDE.md)
# Exit: 0 ok | 1 error | 2 usage
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"
AGENT=""; PROJECT="$(dirname "$TOOLKIT_DIR")"; INSTALL=0; DRY=0; REMOVE=0
while [ $# -gt 0 ]; do case $1 in
  --agent) AGENT=${2:?}; shift;; --project) PROJECT=${2:?}; shift;; --install-skills) INSTALL=1;;
  --dry-run) DRY=1;; --remove) REMOVE=1;; -h|--help) sed -n '2,9p' "$0"; exit 0;; *) err "unknown option $1"; exit 2;; esac; shift; done
BEGIN='<!-- ai-agent-toolkit:begin -->'; END='<!-- ai-agent-toolkit:end -->'
ENTRY="$TOOLKIT_DIR/agents/ENTRY_INSTRUCTION.md"; [ -f "$ENTRY" ] || die "missing $ENTRY" 1
case $AGENT in
  claude-code) FILES=("$PROJECT/CLAUDE.md");; kilo-code|antigravity) FILES=("$PROJECT/AGENTS.md");;
  opencode) if [ ! -f "$PROJECT/AGENTS.md" ] && [ -f "$PROJECT/CLAUDE.md" ]; then FILES=("$PROJECT/CLAUDE.md"); else FILES=("$PROJECT/AGENTS.md"); fi;;
  *) err "--agent required: claude-code|opencode|antigravity|kilo-code"; exit 2;; esac

# Entry text points at the toolkit folder name relative to the project, so copies stay portable.
REL=$(python3 -c 'import os,sys;print(os.path.relpath(sys.argv[1],sys.argv[2]))' "$TOOLKIT_DIR" "$PROJECT")
block() { printf '%s\n' "$BEGIN"; sed "s#{{TOOLKIT}}#$REL#g" "$ENTRY"; printf '%s\n' "$END"; }

for f in "${FILES[@]}"; do
  if [ $REMOVE = 1 ]; then
    [ -f "$f" ] && grep -qF "$BEGIN" "$f" || { log "no toolkit block in $f"; continue; }
    [ $DRY = 1 ] && { log "would remove block from $f"; continue; }
    cp -p "$f" "$f.bak.$(date +%s)"; python3 - "$f" "$BEGIN" "$END" <<'PY'
import sys,re
f,b,e=sys.argv[1:4]; t=open(f).read()
t=re.sub(re.escape(b)+r".*?"+re.escape(e)+r"\n?","",t,flags=re.S); open(f,"w").write(t)
PY
    ok "removed block from $f"; continue
  fi
  [ $DRY = 1 ] && { log "would write toolkit block to $f"; continue; }
  mkdir -p "$(dirname "$f")"
  if [ -f "$f" ]; then cp -p "$f" "$f.bak.$(date +%s)"; fi
  tmp=$(mktemp); block > "$tmp"
  python3 - "$f" "$tmp" "$BEGIN" "$END" <<'PY'
import sys,re,os
f,blk,b,e=sys.argv[1:5]; new=open(blk).read()
t=open(f).read() if os.path.exists(f) else ""
if b in t: t=re.sub(re.escape(b)+r".*?"+re.escape(e)+r"\n?",lambda m:new,t,flags=re.S)
else: t=(t.rstrip("\n")+"\n\n" if t.strip() else "")+new
open(f,"w").write(t)
PY
  rm -f "$tmp"
  grep -qF "$BEGIN" "$f" && grep -qF "$END" "$f" && ok "configured $f" || die "validation failed for $f" 1
done
[ $INSTALL = 1 ] && [ $REMOVE = 0 ] && { "$DIR/install-skills.sh" --agent "$AGENT" --project "$PROJECT" $( [ $DRY = 1 ] && echo --dry-run ); }
exit 0
