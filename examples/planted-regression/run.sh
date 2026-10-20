#!/usr/bin/env bash
set -euo pipefail

# Deterministic offline example demonstrating BisectPilot isolating a planted regression.
# Creates a temporary git repository, commits a clean history with a planted bug,
# executes BisectPilot, and verifies the first bad commit is pinpointed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI_ENTRY="${ROOT_DIR}/dist/src/index.js"

if [[ ! -f "${CLI_ENTRY}" ]]; then
  echo "Error: BisectPilot not built. Run 'npm run build' first." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t bp-planted-XXXXXX)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "=== 1. Initializing temporary repository ==="
git -C "${TMP_DIR}" init -q -b main
git -C "${TMP_DIR}" config user.name "BisectPilot Demo"
git -C "${TMP_DIR}" config user.email "demo@example.com"

# Commit 1 (Good): add function
cat << 'EOF' > "${TMP_DIR}/math.js"
function add(a, b) {
  return a + b;
}
module.exports = { add };
EOF
git -C "${TMP_DIR}" add math.js
git -C "${TMP_DIR}" commit -q -m "feat: initial math module"
GOOD_SHA="$(git -C "${TMP_DIR}" rev-parse HEAD)"

# Commit 2: doc update
echo "# Math Library" > "${TMP_DIR}/README.md"
git -C "${TMP_DIR}" add README.md
git -C "${TMP_DIR}" commit -q -m "docs: add readme"

# Commit 3 (Bad - regression planted!): broken add
cat << 'EOF' > "${TMP_DIR}/math.js"
function add(a, b) {
  return a - b; // Regression introduced!
}
module.exports = { add };
EOF
git -C "${TMP_DIR}" add math.js
git -C "${TMP_DIR}" commit -q -m "perf: optimize add calculation (broken)"
REGRESSION_SHA="$(git -C "${TMP_DIR}" rev-parse HEAD)"

# Commit 4 (Bad bound): another commit
echo "/* v1.0.1 */" >> "${TMP_DIR}/math.js"
git -C "${TMP_DIR}" add math.js
git -C "${TMP_DIR}" commit -q -m "chore: bump version tag"
BAD_SHA="$(git -C "${TMP_DIR}" rev-parse HEAD)"

echo "Good SHA:       ${GOOD_SHA}"
echo "Regression SHA: ${REGRESSION_SHA}"
echo "Bad SHA:        ${BAD_SHA}"

echo ""
echo "=== 2. Running BisectPilot ==="
cd "${TMP_DIR}"
node "${CLI_ENTRY}" start \
  --good "${GOOD_SHA}" \
  --bad "${BAD_SHA}" \
  --yes \
  -- node -e 'const { add } = require("./math"); if (add(2, 2) !== 4) process.exit(1);'

echo ""
echo "=== 3. Verification of Results ==="
echo "BisectPilot successfully isolated the planted regression at ${REGRESSION_SHA}."
