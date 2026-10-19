# BisectPilot

Local-first, evidence-first Git regression bisection engine and interactive trace replay workspace.

## Architecture Overview

This repository houses:
1. **TypeScript/Node.js Regression Bisection Engine (`src/`, `tests/`)** — Implements the BisectPilot blueprint (`src/contracts/`, `src/adapters/`, `src/domain/`, `src/runner/`, `src/application/`):
   - **Worktree Isolation**: Safe detached worktree creation, guarded ownership verification, and automatic post-step cleanup (`A1`–`A2`).
   - **Deterministic Environment**: Shell-free process execution, strict environment allowlist with deterministic defaults (`CI=1`, `TZ=UTC`, `LANG=C.UTF-8`, `NO_COLOR=1`), and output buffer limits (`A3`).
   - **Flexible Oracles**: `in-tree`, `overlay` (with SHA-256 snapshotting, conflict checks, and guaranteed cleanup), and `external` oracle modes (`A4`).
   - **Strict Classification**: 4-kind classification (`good` -> `0`, `bad` -> `1`, `skip` -> `125`, `abort` -> `128`, never `126`/`127`) (`A5`–`A6`).
   - **Evidence Ledger**: Tamper-evident, hash-chained JSONL evidence ledger (`verifyLedgerChain`) with sensitive token redaction (`A7`).
   - **Automatic Good-Endpoint Discovery**: Exponential search (`1, 2, 4, 8...` commits or tags) for reliable good boundaries via `--good auto` (`P1`).
   - **Interactive Classification**: Human-in-the-loop classification prompt via `--prompt` with execution previews and manual provenance tracking (`P1`).
   - **Toolchain Wrappers**: Historical runtime version adaptation (e.g. `fnm exec --using=<version>`) via `toolchainWrapper` (`P1`).
   - **Custom Bisect Terms**: Native Git bisect terms (`--terms <old,new>`) mapped to `--term-old`/`--term-new` with candidate boundary preservation (`P1`).
   - **Noisy-Oracle Reliability**: Closed-form Bayesian posterior updates ($P(\text{bad}) = \frac{1}{1 + r^{\text{passes} - \text{fails}}}$) with early stopping and flake rate tolerance (`--noisy`) (`P1`).
   - **Reproducibility Bundle**: Standalone `repro.sh` generator with prerequisite validation, isolated worktree test, and exit code contract (`B6`).
2. **Python Trace Diff Utility (`src/bisectpilot/__init__.py`)** — Zero-dependency JSONL trace diff helper and web run exporter (`npm run test:py`).
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

## CLI Usage

```bash
# Doctor diagnostic
bisectpilot doctor [repoPath]

# Initialize starter configuration
bisectpilot init [--out <config.json>]

# Plan bisection range and estimate steps
bisectpilot plan --config <config.json> [--good <ref>] [--bad <ref>] [--terms <old,new>]

# Start automated bisection
bisectpilot start --config <config.json> [--yes] [--good <ref>] [--bad <ref>] [--terms <old,new>] [--noisy] [--prompt]

# Inspect session status, resume after crash, or generate handoff report
bisectpilot status <sessionId>
bisectpilot resume <sessionId>
bisectpilot report <sessionId> [--json] [--verify]
bisectpilot cleanup <sessionId> [--dry-run]
bisectpilot list
```

## Scripts

- `npm run build` — Compile TypeScript (`src/`, `tests/`) to `dist/`
- `npm run typecheck` — Strict TypeScript check (`tsc --noEmit`)
- `npm test` — Run all 85 unit, integration, and safety tests
- `npm run test:py` — Run Python trace diff unit tests
- `npm --prefix website run test` — Run website typecheck, linting, and build
