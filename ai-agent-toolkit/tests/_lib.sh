# tiny assert helpers for tests (source me)
T_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; TK="$(cd "$T_DIR/.." && pwd)"
P=0; F=0
t_ok()   { P=$((P+1)); echo "PASS  $*"; }
t_bad()  { F=$((F+1)); echo "FAIL  $*"; }
check()  { local d=$1; shift; if "$@" >/dev/null 2>&1; then t_ok "$d"; else t_bad "$d"; fi; }
finish() { echo "-- $(basename "$0"): $P passed, $F failed"; [ $F -eq 0 ]; }
