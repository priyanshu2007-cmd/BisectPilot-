#!/usr/bin/env bash
# Lookup toolkit skills. Usage: scripts/skill-search.sh "react hydration bug" [--top N] [--source NAME] [--json]
# Exit: 0 match | 1 no match | 2 usage | 3 python3 or index missing
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$DIR/.." && pwd)"
[ $# -ge 1 ] || { sed -n '2,3p' "$0"; exit 2; }
command -v python3 >/dev/null || { echo "python3 required" >&2; exit 3; }
[ -f "$ROOT/config/skill-index.json" ] || { echo "index missing: run scripts/bootstrap.sh --no-download" >&2; exit 3; }
exec python3 -I "$DIR/lib/search.py" "$ROOT" "$@"
