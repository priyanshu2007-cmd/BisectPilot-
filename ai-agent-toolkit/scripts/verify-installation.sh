#!/usr/bin/env bash
# Verify the toolkit: structure, JSON, repository completeness, skill metadata, agent registrations, CLIs.
# Usage: scripts/verify-installation.sh [--project DIR] [--no-browser]
# Exit: 0 all required checks pass (warnings allowed) | 1 at least one FAIL
# Never prints secret values: the secret scan reports file paths only.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$DIR/lib/common.sh"
PROJECT="$(dirname "$TOOLKIT_DIR")"; BROWSER=1
while [ $# -gt 0 ]; do case $1 in --project) PROJECT=${2:?}; shift;; --no-browser) BROWSER=0;; -h|--help) sed -n '2,5p' "$0"; exit 0;; *) err "unknown option $1"; exit 2;; esac; shift; done
need jq
P=0; F=0; WN=0
pass() { P=$((P+1)); printf 'PASS  %s\n' "$*"; }; fail() { F=$((F+1)); printf 'FAIL  %s\n' "$*"; }; wrn() { WN=$((WN+1)); printf 'WARN  %s\n' "$*"; }

echo "== structure"
for f in README.md QUICKSTART.md MANIFEST.md CHANGELOG.md .gitignore config/repository-manifest.json config/skill-index.json config/agent-capabilities.json config/sources.json \
  guides/COMPLETE_INSTALLATION_GUIDE.md guides/REPOSITORY_CATALOG.md guides/WEBSITE_DEVELOPMENT.md guides/TOKEN_OPTIMIZATION.md guides/SECURITY.md guides/MCP_SETUP.md guides/TROUBLESHOOTING.md guides/UPDATING.md \
  agents/antigravity/INSTALL.md agents/antigravity/AGENTS.md agents/opencode/INSTALL.md agents/opencode/AGENTS.md agents/claude-code/INSTALL.md agents/claude-code/CLAUDE.md agents/kilo-code/INSTALL.md agents/kilo-code/AGENTS.md agents/ENTRY_INSTRUCTION.md \
  scripts/bootstrap.sh scripts/install-skills.sh scripts/update-toolkit.sh scripts/verify-installation.sh scripts/audit-repositories.sh scripts/setup-agent.sh scripts/skill-search.sh \
  tests/test-manifest.sh tests/test-skill-discovery.sh tests/test-installation.sh local/README.md; do
  [ -f "$TOOLKIT_DIR/$f" ] && pass "file $f" || fail "missing $f"; done
for s in "$TOOLKIT_DIR"/scripts/*.sh "$TOOLKIT_DIR"/tests/*.sh; do [ -x "$s" ] || fail "not executable: ${s#"$TOOLKIT_DIR"/}"; done

echo "== json"
for j in "$TOOLKIT_DIR"/config/*.json; do jq empty "$j" 2>/dev/null && pass "valid JSON ${j#"$TOOLKIT_DIR"/}" || fail "invalid JSON ${j#"$TOOLKIT_DIR"/}"; done

echo "== repositories"
n=$(jq length "$SOURCES_JSON"); m=$(jq '.repositories|length' "$TOOLKIT_DIR/config/repository-manifest.json")
[ "$n" = "$m" ] && pass "manifest has all $n sources" || fail "manifest has $m of $n sources"
while IFS=$'\t' read -r name st path; do
  case $st in
    retrieved) [ -f "$TOOLKIT_DIR/$path/.source.json" ] && [ "$(find "$TOOLKIT_DIR/$path" -type f | wc -l)" -gt 2 ] && pass "$name retrieved" || fail "$name marked retrieved but files missing";;
    pointer-only) [ -f "$TOOLKIT_DIR/$path/POINTER.md" ] && pass "$name pointer-only" || fail "$name pointer missing";;
    *) fail "$name status=$st (not retrieved)";; esac
done < <(jq -r '.repositories[]|[.name,.installation_status,(.local_path//"-")]|@tsv' "$TOOLKIT_DIR/config/repository-manifest.json")

echo "== skills"
bad=$(jq -r '.skills[]|select(.frontmatter_ok|not)|.path' "$TOOLKIT_DIR/config/skill-index.json")
[ -z "$bad" ] && pass "all indexed skills have name+description" || { fail "skills missing name/description:"; echo "$bad" | sed 's/^/        /'; }
for d in "$TOOLKIT_DIR"/skills/*/; do n=$(basename "$d"); fn=$(sed -n 's/^name: *//p' "$d/SKILL.md" | head -1)
  [ "$fn" = "$n" ] && echo "$n" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' && [ ${#n} -le 64 ] && pass "skill $n frontmatter" || fail "skill $n: name '$fn' != folder"; done
dl=$(jq -r '.skills[]|select((.description|length)>1024)|.id' "$TOOLKIT_DIR/config/skill-index.json" | head -3); [ -z "$dl" ] || wrn "description >1024 chars (OpenCode/Kilo limit) in: $dl"

echo "== secrets (paths only)"
hits=$(grep -rIlE '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' "$TOOLKIT_DIR/skills" "$TOOLKIT_DIR/scripts" "$TOOLKIT_DIR/config" "$TOOLKIT_DIR/guides" "$TOOLKIT_DIR/agents" 2>/dev/null)
[ -z "$hits" ] && pass "no secret-like strings in toolkit-owned files" || { fail "secret-like strings in:"; echo "$hits" | sed 's/^/        /'; }

echo "== agent registrations (project: $PROJECT)"
for pair in "claude-code:.claude/skills" "opencode:.opencode/skills" "kilo-code:.kilo/skills" "antigravity:.agents/skills"; do
  a=${pair%%:*}; d=$PROJECT/${pair#*:}
  [ -f "$d/skill-scout/.toolkit-managed" ] && pass "$a: skills installed in ${pair#*:}" || wrn "$a: skill-scout not installed in ${pair#*:} (run install-skills.sh --agent $a)"; done
for f in CLAUDE.md AGENTS.md; do grep -qs 'ai-agent-toolkit:begin' "$PROJECT/$f" && pass "entry block in $f" || wrn "no entry block in $PROJECT/$f (run setup-agent.sh)"; done

echo "== CLIs"
for t in git node npm python3 uv jq rsync; do have $t && pass "$t $($t --version 2>&1 | head -1)" || wrn "$t not found"; done
if have browser-harness; then
  pass "browser-harness $(browser-harness --version 2>&1 | head -1)"
  if [ $BROWSER = 1 ]; then
    d=$(perl -e 'alarm 40; exec @ARGV' browser-harness --doctor 2>&1)
    echo "$d" | grep -q 'daemon alive' && ! echo "$d" | grep -q 'FAIL\] daemon alive' && pass "browser connected" || wrn "browser not connected (enable chrome://inspect/#remote-debugging, then browser-harness --doctor)"
    browser-harness recordings 2>&1 | head -1 | sed 's/^/        recordings: /'
  fi
else wrn "browser-harness not installed (scripts/bootstrap.sh --browser-harness)"; fi

echo; echo "summary: $P passed, $F failed, $WN warnings"
[ $F -eq 0 ]
