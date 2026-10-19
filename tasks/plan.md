# Implementation Plan: BisectPilot CLI & Explorer Integration

> **Spec**: [SPEC.md](file:///Users/priyanshu/Documents/BisectPilot/SPEC.md)

## Initial Tasks

### Task 1: Remove unused dependency from `pyproject.toml`
- **Files**: `pyproject.toml`
- **Change**: Set `dependencies = []` (remove unused `browser-use>=0.13.11`) and verify `[project.scripts] bisectpilot = "bisectpilot:main"`.
- **Status**: Completed.

### Task 2: TDD — Write unit tests for `bisectpilot` CLI & bisection engine
- **Files**: `tests/test_bisectpilot.py`
- **Tests**: Canonical normalization, turn alignment, scenario JSON output, `--export-web` security.
- **Status**: Completed.

### Task 3: Implement `src/bisectpilot/__init__.py` (stdlib only)
- **Files**: `src/bisectpilot/__init__.py`
- **Change**: Implement `canonicalize()`, `align_turns()`, `bisect_traces()`, `export_web_run()`, and `main()` supporting `diff` and `bisect` subcommands (~120 LOC stdlib Python).
- **Status**: Completed.

### Task 4: Connect `/explorer` (`website/components/PilotConsole.tsx`) to exported & uploaded runs
- **Files**: `website/components/PilotConsole.tsx`
- **Change**: Added `isValidScenario()`, `/runs/index.json` loader, and `.json` file import in `website/components/PilotConsole.tsx`.
- **Status**: Completed.

## Step 2: Auto Good Discovery & CLI Replay Plan
- **Files**: `src/adapters/git/git-client.ts`, `src/cli/index.ts`, `src/reports/replay-adapter.ts`, `website/components/PilotConsole.tsx`
- **Change**: `--good auto` merge-base discovery, CLI report replay adapter with schema validation.
- **Status**: Completed.

## Step 3: Human-in-the-Loop Oracle & Toolchain Wrapper Plan
- **Files**: `src/oracle/index.ts`, `src/cli/index.ts`
- **Change**: `--prompt` interactive classification with readline timeout; `--toolchain` runtime prefix wrapper.
- **Status**: Completed.

## Step 4: Custom Terms, Noisy-Oracle Reliability & Release Hardening Plan
- **Files**: `src/contracts/config.ts`, `src/domain/bayesian.ts`, `src/domain/classification.ts`, `src/reports/index.ts`, `src/adapters/process/process-runner.ts`, `tests/fixtures/fake-engine.ts`, `.github/workflows/ci.yml`
- **Change**: Custom bisect terms (`--terms <old>:<new>`), Bayesian SPRT noisy oracle (`--noisy`), standalone reproduction bundle (`repro.sh` / `repro.ps1`), test fixture decoupling, cross-platform process tree cleanup, and GitHub Actions CI.
- **Status**: Completed.

