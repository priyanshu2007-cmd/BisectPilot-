#!/usr/bin/env bash
# Discovery tests: right skills surface, only a handful are returned.
set -uo pipefail; . "$(dirname "$0")/_lib.sh"
S="$TK/scripts/skill-search.sh"
expect() { # query expected-path-fragment
  out=$("$S" "$1" --top 3 2>/dev/null); echo "$out" | grep -q "$2" && t_ok "'$1' -> $2" || { t_bad "'$1' missing $2"; echo "$out" | sed 's/^/      /'; }; }
expect "design a modern marketing website with react and tailwind" "skills/website-builder"
expect "fix react hydration bug in checkout page" "skills/coding-and-debugging"
expect "browser test the login page and take a screenshot" "skills/browser-automation"
expect "security audit for xss and exposed secrets" "skills/security-review"
expect "integrate a third party api and configure mcp server" "skills/api-and-mcp-integration"
expect "research library documentation for next.js caching" "skills/research-and-documentation"
expect "reduce token usage on large repo" "skills/token-saver"
n=$("$S" "website design" --top 3 | grep -c '^ *[0-9]'); total=$(jq .count "$TK/config/skill-index.json")
[ "$n" -le 3 ] && [ "$total" -gt 20 ] && t_ok "returns $n of $total skills (not all loaded)" || t_bad "returned $n of $total"
"$S" "zzzqqq unrelated gibberish" >/dev/null 2>&1; [ $? -eq 1 ] && t_ok "no match -> exit 1" || t_bad "gibberish matched"
irrelevant=$("$S" "react component accessibility" --top 3 | grep -ciE 'strix|penetration'); [ "$irrelevant" = 0 ] && t_ok "security-testing skills not returned for a frontend query" || t_bad "irrelevant skill returned"
finish
