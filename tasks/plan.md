# Implementation Plan: BisectPilot CLI & Explorer Integration

> **Spec**: [SPEC.md](../SPEC.md)

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

## Step 5: Delta Debugging, Input Minimization & npm Distribution Plan

- **Files**: `src/domain/minimizer.ts`, `src/application/index.ts`, `src/cli/index.ts`, `src/contracts/fake-engine.ts`, `package.json`, `LICENSE`, `tests/unit/minimizer.test.ts`, `tests/integration/package-distribution.test.ts`, `.github/workflows/ci.yml`
- **Change**: Delta Debugging (`ddmin`) line and character reduction algorithm with path traversal protection, workspace isolation, baseline checks, and Bayesian noisy oracle; strict npm distribution packaging whitelist, symlink resolution in CLI, and isolated consumer installation tests.
- **Status**: Completed.

## Step 6: Standalone Offline HTML Reports & GitHub Actions Integration Plan

- **Files**: `src/reports/html-report.ts`, `src/reports/github-summary.ts`, `src/reports/index.ts`, `src/cli/index.ts`, `tests/unit/html-report.test.ts`, `tests/unit/github-summary.test.ts`
- **Change**: Self-contained zero-dependency interactive offline HTML report (`report.html`), GitHub Actions `$GITHUB_STEP_SUMMARY` formatter and Issue/PR Markdown exporter (`generateGitHubIssueMarkdown`).
- **Status**: Completed.

## Step 7: Monorepo & Multi-Package Workspace Bisection Plan

- **Files**: `src/domain/workspace.ts`, `src/domain/index.ts`, `src/contracts/config.ts`, `src/contracts/ledger.ts`, `src/contracts/outcome.ts`, `src/adapters/git/git-client.ts`, `src/application/index.ts`, `src/oracle/index.ts`, `src/reports/index.ts`, `src/reports/html-report.ts`, `src/reports/github-summary.ts`, `src/cli/index.ts`, `README.md`, `tests/unit/workspace.test.ts`, `tests/integration/monorepo-bisect.test.ts`
- **Change**: Workspace-aware bisection with `--cwd <path>` and optional `--scope <paths>` across `plan`, `start`, and `run`; path traversal & symlink validation; package-scoped native `git bisect start -- <paths...>` history limiting with automatic root manifest and lockfile inclusion; historical revision dependency hashing; automatic `untestable_revision` skip for commits prior to package introduction; reproduction script and report integration.
- **Status**: Completed.

## Step 9: Local Daemon, Durable Jobs & Pull Workers

- **Scope**: Add a standard-library-only local daemon, authenticated loopback/HTTPS-capable worker protocol, durable job queue, leases, heartbeats, cancellation and conservative recovery around the existing `LocalBisectEngine`.
- **Architecture**: Keep one microlithic process model. The daemon owns queue transitions and leases; workers execute only validated bisection configs in pre-provisioned repositories; the existing engine remains authoritative for classification and session state.
- **CLI**: Add `daemon start|status|stop|enqueue|cancel|recover` and `worker start|status|stop`. Add `start --background` as a thin enqueue path. Keep foreground/internal process modes for tests and supervision.
- **Security**: Loopback bind by default; bearer token from a protected file; constant-time comparison; bounded JSON requests; non-loopback HTTP refused unless HTTPS certificate/key are configured; no token logging; async jobs reject persisted `envOverrides`.
- **Recovery**: Atomic queue snapshots with validated job transition history. Lease expiry before execution retries; started or ambiguous work becomes `needs_recovery`; explicit recover is required before retrying unsafe work. Native Git Bisect remains serialized per job/session.
- **Verification**: Unit-test transitions, atomic persistence, auth, bounds, duplicate delivery/results and recovery. Add loopback integration coverage with a temporary Git repo and the real engine. Preserve all Step 8 tests and package behavior.
- **Status**: Implementation and local regression verification complete; remote TLS, separate-machine and Windows behavior remain unverified.

## Step 10: Rootless Container Sandbox & Untrusted Commit Execution

- **Master-plan mapping**: Section 19.3/Section 8.5 identifies container execution as an optional future hardened mode. Current worktree/process isolation is not a sandbox; no runtime, image, mount, network or resource policy exists.
- **Scope**: Add an opt-in `execution.sandbox` policy implemented at the existing `runSafeProcess()` boundary. Default execution remains unchanged. Docker/Podman CLI use is explicit, digest-pinned, rootless-verified, no-network and no-host-credential by construction; image pulls and arbitrary mounts are rejected.
- **Integration**: Carry the validated policy through foreground and async jobs. Workers advertise sandbox capability and reject sandbox jobs when unavailable. Sandbox failures are infrastructure outcomes, never ordinary regression evidence.
- **Lifecycle**: Create/start/inspect/stop/remove only owned containers; preserve AbortSignal, timeout, bounded output and ledger provenance. A lost cleanup is recorded as an explicit limitation and never followed by broad container cleanup.
- **Verification**: Fake runtime tests cover validation, argv hardening, mounts, env filtering, result mapping, cancellation and ownership. A real runtime integration test is explicitly skipped with a reason when Docker/Podman/rootless/image prerequisites are unavailable. Full existing suites and package checks remain required.
- **Status**: Implementation and local regression verification complete; real Docker/Podman rootless isolation remains unverified when runtime/image prerequisites are unavailable.

## Step 14: Session Recovery, Master-Plan Audit & Release Readiness

- **Scope**: Ledger-as-WAL plus versioned checksummed checkpoints with backup and ledger reconstruction; fast resume via cached classifications; daemon-startup flagging of dead-owner sessions; Mann-Whitney U; Grafana template.
- **Status**: Implemented and verified.

## Release Verification & Hardening Milestone Plan

- **Scope**: Fresh-clone isolated end-to-end bisection verification (`tests/integration/fresh-clone-e2e.test.ts`), P1.1-P1.6 resolution, durable checkpoint writes (`fsyncSync` of temp file and POSIX directory metadata in `src/session/checkpoint.ts`), subprocess-kill (SIGKILL) crash tests, unsupported schema and wrong-repo rejection, recovery CLI documentation (`needs_recovery`), and multi-machine mTLS runbook (`docs/multimachine-mtls-setup.md`).
- **Files Modified / Created**:
  - `src/session/checkpoint.ts` (fsyncSync durability)
  - `src/cli/index.ts` (recovery help text)
  - `tests/integration/session-resume-recovery.test.ts` (SIGKILL crash tests, schemaVersion 99, wrong-repo)
  - `tests/integration/fresh-clone-e2e.test.ts` (fresh-clone bisection, report consistency, XSS escaping, timeout safety)
  - `docs/multimachine-mtls-setup.md` (multi-machine mTLS deployment & partition test runbook)
  - `README.md`, `docs/architecture.md`, `docs/safety-model.md`, `docs/handoff.md`, `tasks/todo.md`, `AI_BRAIN.md`, `SESSION_MEMORY.md`
- **Status**: Implementation, local suites (229 tests, 228 pass, 1 skip), packaging (dry-run & external consumer project install), and website verification completed. Platform CI blockers identified and documented.
