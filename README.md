# BisectPilot

Local-first, evidence-first Git regression bisection engine and interactive trace replay workspace.

## Architecture Overview

This repository houses:
1. **TypeScript/Node.js Regression Bisection Engine (`src/`, `tests/`)** — Implements the BisectPilot v3 blueprint (`src/contracts/`, `src/adapters/`, `src/domain/`, `src/runner/`, `src/application/`):
   - Safe detached worktree isolation (`A1`–`A2`)
   - Shell-free process-group execution & deterministic environment policy (`A3`)
   - `in-tree`, `overlay`, and `external` oracle modes with SHA-256 snapshotting & guaranteed cleanup (`A4`)
   - Strict 4-kind classification (`good` -> `0`, `bad` -> `1`, `skip` -> `125`, `abort` -> `128`, never `126`/`127`) (`A5`–`A6`)
   - Atomic session manifests, hash-chained JSONL evidence ledger, and lockfile management (`A7`)
   - Endpoint flake preflight (`k=3` default), native `git bisect` orchestration, boundary verification, and crash recovery (`A8`–`A10`)
2. **Python Trace Diff Utility (`src/bisectpilot/__init__.py`)** — Preserved zero-dependency JSONL trace diff helper (`npm run test:py`).
3. **Interactive Web Console (`website/`)** — Next.js 16 product site and `/explorer` interactive replay specimen.

## Requirements

- **Node.js** `>= 20.0.0` (pinned to `v24.18.0` in `.nvmrc`)
- **Git** `>= 2.36.0`

## Quick Start

```bash
npm ci
npm run typecheck
npm test
```

## Scripts

- `npm run build` — Compile TypeScript (`src/`, `tests/`) to `dist/`
- `npm run typecheck` — Strict TypeScript check (`tsc --noEmit`)
- `npm test` — Run all unit and integration tests on real temporary Git repositories
- `npm run test:py` — Run preserved Python trace diff unit tests
