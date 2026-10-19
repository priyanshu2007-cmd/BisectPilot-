# Task Checklist: BisectPilot Development Milestones

## Initial Setup & Explorer Integration
- [x] Update `.vscode/settings.json` for ultra-clean Explorer mode & ponytail-review slimming
- [x] Install `@juliusbrussee/caveman-code` globally (`npm install -g @juliusbrussee/caveman-code`)
- [x] Apply `/learn` session learnings to `AI_RULES.md` and `.agents/skills/coding-and-debugging/SKILL.md`
- [x] Author `SPEC.md` and `tasks/plan.md`
- [x] Task 1: Clean `pyproject.toml` (`dependencies = []`)
- [x] Task 2: Add `tests/test_bisectpilot.py` unit test suite
- [x] Task 3: Implement `src/bisectpilot/__init__.py` stdlib CLI (`diff` + `bisect` + `--export-web`)
- [x] Task 4: Add `isValidScenario()`, `/runs/index.json` loader, and `.json` file import in `website/components/PilotConsole.tsx`

## Step 1: Engine Foundation & Microlithic Architecture
- [x] Implement Phase G0 contracts in `src/contracts/`
- [x] Implement Git client and guarded worktree manager (`src/adapters/git/`)
- [x] Implement process runner, classifier, and hash-chained ledger (`src/adapters/process/`, `src/domain/`)
- [x] Implement end-to-end BisectEngine integration (`src/application/`)

## Step 2: Automatic Good-Endpoint Discovery & CLI Report Replay
- [x] Add `--good auto` merge-base and exponential backoff scan in `src/adapters/git/git-client.ts`
- [x] Add CLI `--good auto` flag support in `src/cli/index.ts`
- [x] Implement `src/reports/replay-adapter.ts` (`adaptCliReportToReplayScenario()`)
- [x] Wire CLI report upload to `website/components/PilotConsole.tsx` with schema validation
- [x] Add unit tests for auto-good discovery and report replay adapter

## Step 3: Human-in-the-Loop Oracle & Toolchain Wrapper
- [x] Add `--prompt` interactive terminal oracle in `src/oracle/index.ts`
- [x] Support `good`, `bad`, and `skip` responses with input sanitization and timeout
- [x] Implement `--toolchain` runtime wrapper in `src/oracle/index.ts`
- [x] Add unit tests in `tests/unit/prompt-oracle.test.ts` and `tests/unit/toolchain-wrapper.test.ts`

## Step 4: Custom Bisect Terms, Noisy-Oracle Reliability & Release Hardening
- [x] Implement `--terms <term_old>:<term_new>` in `src/contracts/config.ts`, `src/domain/classification.ts`, `src/application/index.ts`, `src/cli/index.ts`
- [x] Implement Bayesian sequential probability ratio test (SPRT) in `src/domain/bayesian.ts` with `--noisy` flag
- [x] Implement standalone `repro.sh` / `repro.ps1` reproduction bundle generator in `src/reports/index.ts`
- [x] Decouple `FakeEngine` from production contracts into `tests/fixtures/fake-engine.ts` with backward compatibility re-export
- [x] Handle process-tree termination safely across OS platforms in `src/adapters/process/process-runner.ts`
- [x] Fix website dev-dependency advisory via `braces` package override in `website/package.json`
- [x] Author GitHub Actions CI workflow in `.github/workflows/ci.yml`
- [x] Verify all 85 engine tests, 4 Python tests, and website build pass cleanly
- [x] Update all `.md` documentation files and push branch to origin

