# BisectPilot Development, Testing & Reproducibility

## Clean Linux Rebuild

The repository is designed to rebuild without any files from the original
developer machine. The reproducibility contract is:

- Git history is committed in the repository itself.
- Root JavaScript dependencies are locked by `package-lock.json`.
- Website dependencies are locked by `website/package-lock.json`.
- Python packaging metadata is locked by `uv.lock` and requires no runtime
  Python dependencies.
- Node is pinned to `v24.18.0` in `.nvmrc` and Docker uses the matching
  `node:24.18.0-bookworm-slim` image.
- Python is pinned to `3.12` in `.python-version`.
- `.env.example` contains only non-secret local defaults; real `.env*` files are
  ignored by Git and Docker's build context.
- `Makefile` provides one aggregate test command: `make test`.

On a clean Linux machine with Git, Node `v24.18.0`, Python `3.12`, npm, and
GNU Make installed:

```bash
git clone https://github.com/priyanshu2007-cmd/BisectPilot-.git
cd BisectPilot-
nvm install
nvm use
make setup
make build
make test
make run
```

`make test` runs the TypeScript engine tests, Python tests, and website
typecheck/lint/production build. `make run` performs a CLI smoke run and prints
the command help. For an actual investigation, use the CLI workflow described
in [Quick Start](#quick-start).

### Docker rebuild and smoke run

Docker is an alternative when Node/npm are not installed on the host:

```bash
docker build --tag bisectpilot:local .
docker run --rm bisectpilot:local --help
```

The image builds the TypeScript CLI from the locked root npm dependencies and
runs it as the non-root `node` user. The website is built by `make build` and
`make test`; it is intentionally a separate static application from the CLI
runtime image.

---



## Python Helper and Website

BisectPilot includes two optional supporting tools alongside the main TypeScript Git bisection CLI.

### 1. Python JSONL Trace-Diff Utility (`src/bisectpilot/__init__.py`)

A zero-dependency Python utility (`pyproject.toml` entry point `bisectpilot = "bisectpilot:main"`) for comparing baseline and candidate JSONL execution traces, identifying the first turn where output drifts, and exporting scenarios for the replay console.

```bash
# Run Python unit tests
npm run test:py

# Run the Python CLI entry point directly from source (POSIX)
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" --help
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" diff baseline.jsonl current.jsonl --out scenario.json
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" bisect baseline.jsonl..current.jsonl --export-web
```

On Windows PowerShell:

```powershell
$env:PYTHONPATH="src"; python -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" --help
```

### 2. Next.js Interactive Replay Website (`website/`)

A static Next.js 16 web application providing product documentation (`/docs`) and an interactive replay console (`/explorer`) that visualizes sample scenarios or imports `bisectpilot report <sessionId> --json` files via drag-and-drop.

```bash
npm --prefix website ci
npm --prefix website run dev
# Open http://localhost:3000
```

---

## Development and Testing

### Root Package Commands

```bash
# Install root dependencies
npm ci

# Compile TypeScript (src/ and tests/) to dist/
npm run build

# Run strict TypeScript typechecking without emitting files
npm run typecheck

# Compile and run all TypeScript unit, integration, and safety test suites
npm test
```

### Focused Test Suites

```bash
# Run only unit, integration, or safety suites via the cross-platform test runner
npm run test:unit
npm run test:integration
npm run test:safety

# Run a single compiled integration test file directly
node --test dist/tests/integration/fresh-clone-e2e.test.js
node --test dist/tests/integration/session-resume-recovery.test.js
node --test dist/tests/integration/mtls-remote-worker.test.js
node --test dist/tests/integration/package-distribution.test.js
```

### Python and Website Test Commands

```bash
# Run Python trace-diff unit tests (4 tests)
# Note: npm run test:py uses inline `PYTHONPATH=src` syntax, which requires a POSIX shell (Linux/macOS/Git Bash)
npm run test:py

# Cross-platform Python test command (works in Windows PowerShell/CMD and POSIX)
python -m unittest discover -s tests -v   # with PYTHONPATH=src set in environment

# Install and validate the Next.js website (typecheck + ESLint + production static build)
npm --prefix website ci
npm --prefix website run test
```

### Packaging Check

```bash
# Verify tarball contents without publishing
npm pack --dry-run
```

---
