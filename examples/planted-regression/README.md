# Planted Regression Example (Offline Fixture)

This example demonstrates how BisectPilot isolates an exact regression commit in an isolated, deterministic Git repository without network access.

## What This Example Does

1. Initializes a temporary Git repository in `$TMPDIR`.
2. Creates four commits:
   - `C1`: `feat: initial math module` (working `add(a, b)`)
   - `C2`: `docs: add readme`
   - `C3`: `perf: optimize add calculation (broken)` (plants a bug: `return a - b`)
   - `C4`: `chore: bump version tag`
3. Runs `bisectpilot start` with an inline oracle:
   ```bash
   bisectpilot start --good <C1> --bad <C4> --yes -- node -e 'const { add } = require("./math"); if (add(2, 2) !== 4) process.exit(1);'
   ```
4. Displays the human-readable summary confirming that commit `C3` is the regression culprit.
5. Safely cleans up all temporary files on completion.

## Running the Example

```bash
./examples/planted-regression/run.sh
```
