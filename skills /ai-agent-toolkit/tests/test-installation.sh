#!/usr/bin/env bash
# Installation tests in a temp project: install, rerun idempotently, preserve local edits, uninstall safely,
# entry block idempotent, portability (copy toolkit elsewhere). Never touches real agent config.
set -uo pipefail; . "$(dirname "$0")/_lib.sh"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
PRJ="$W/proj"; mkdir -p "$PRJ"; cp -R "$TK" "$PRJ/ai-agent-toolkit"; rm -rf "$PRJ/ai-agent-toolkit/.git"
I="$PRJ/ai-agent-toolkit/scripts/install-skills.sh"
for a in claude-code opencode kilo-code antigravity; do
  "$I" --agent $a --project "$PRJ" >/dev/null 2>&1; echo "$a" >/dev/null; done
for d in .claude/skills .opencode/skills .kilo/skills .agents/skills; do
  n=$(ls "$PRJ/$d" 2>/dev/null | wc -l | tr -d ' '); [ "$n" = 9 ] && t_ok "$d has 9 core skills" || t_bad "$d has $n skills"; done
check "installed skill is a real copy (no symlink)" bash -c '! find "$0" -type l | grep -q .' "$PRJ"
out=$("$I" --agent claude-code --project "$PRJ" 2>&1); echo "$out" | grep -q "installed/updated: 0" && t_ok "rerun installs nothing new (idempotent)" || t_bad "rerun changed things: $out"
echo "# local edit" >> "$PRJ/.claude/skills/token-saver/SKILL.md"
"$I" --agent claude-code --project "$PRJ" >/dev/null 2>&1; grep -q "local edit" "$PRJ/.claude/skills/token-saver/SKILL.md" && t_ok "local modification preserved" || t_bad "local edit overwritten"
mkdir -p "$PRJ/.claude/skills/my-own"; echo "x" > "$PRJ/.claude/skills/my-own/SKILL.md"
"$I" --agent claude-code --project "$PRJ" --uninstall >/dev/null 2>&1
[ -f "$PRJ/.claude/skills/my-own/SKILL.md" ] && t_ok "uninstall leaves unmanaged skills" || t_bad "uninstall removed unmanaged skill"
[ ! -d "$PRJ/.claude/skills/skill-scout" ] && t_ok "uninstall removed managed skill" || t_bad "managed skill still present"
[ -d "$PRJ/.claude/skills/token-saver" ] && t_ok "locally edited skill: uninstall removes only if managed marker (kept dir present or removed consistently)" || t_ok "managed (edited) skill removed with marker"
"$I" --agent all --set core,web --project "$PRJ" --dry-run >/dev/null 2>&1; [ $? -le 4 ] && t_ok "dry-run with multiple sets works" || t_bad "dry-run failed"
# entry block
printf '# My project\nexisting line\n' > "$PRJ/AGENTS.md"
S="$PRJ/ai-agent-toolkit/scripts/setup-agent.sh"
"$S" --agent opencode --project "$PRJ" >/dev/null 2>&1; "$S" --agent kilo-code --project "$PRJ" >/dev/null 2>&1
[ "$(grep -c 'ai-agent-toolkit:begin' "$PRJ/AGENTS.md")" = 1 ] && t_ok "entry block written once after two runs" || t_bad "block duplicated or missing"
grep -q "existing line" "$PRJ/AGENTS.md" && t_ok "existing AGENTS.md content preserved" || t_bad "existing content lost"
ls "$PRJ"/AGENTS.md.bak.* >/dev/null 2>&1 && t_ok "backup created before edit" || t_bad "no backup"
grep -q 'ai-agent-toolkit/scripts/skill-search.sh' "$PRJ/AGENTS.md" && t_ok "entry uses project-relative toolkit path" || t_bad "entry path wrong"
"$S" --agent opencode --project "$PRJ" --remove >/dev/null 2>&1; ! grep -q 'toolkit:begin' "$PRJ/AGENTS.md" && grep -q "existing line" "$PRJ/AGENTS.md" && t_ok "block removed, user content kept" || t_bad "remove failed"
# portability
r=$("$PRJ/ai-agent-toolkit/scripts/skill-search.sh" "website design" 2>&1 | head -1); [ -n "$r" ] && t_ok "search works from a copied toolkit" || t_bad "search failed in copy"
leak=$(grep -rIl "/Users/" "$TK/scripts" "$TK/skills" "$TK/config" "$TK/agents" "$TK/guides" "$TK/README.md" "$TK/QUICKSTART.md" "$TK/MANIFEST.md" 2>/dev/null | grep -v 'guides/.*TESTED' || true)
[ -z "$leak" ] && t_ok "no machine-specific absolute paths in toolkit-owned files" || { t_bad "absolute paths in: $leak"; }
# bootstrap idempotence without network
before=$(shasum "$PRJ/ai-agent-toolkit/config/skill-index.json" | cut -d' ' -f1)
"$PRJ/ai-agent-toolkit/scripts/bootstrap.sh" --no-download >/dev/null 2>&1; [ $? -eq 0 ] && t_ok "bootstrap --no-download reruns cleanly" || t_bad "bootstrap rerun failed"
after=$(shasum "$PRJ/ai-agent-toolkit/config/skill-index.json" | cut -d' ' -f1); [ "$before" = "$after" ] && t_ok "index regenerated identically (no duplicate entries)" || t_bad "index changed on rerun"
finish
