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

## Step 5: Delta Debugging, Input Minimization & npm Distribution

- [x] Implement Delta Debugging (`ddmin`) for line and character reduction in `src/domain/minimizer.ts`
- [x] Add baseline reproduction check to abort safely if input does not reproduce failure
- [x] Add workspace isolation and path traversal guards preventing accidental overwrites
- [x] Integrate Bayesian noisy-oracle multi-sampling support into minimizer
- [x] Add `bisectpilot minimize` CLI command with `--budget`, `--timeout`, `--granularity`, `--noisy`, and `--json`
- [x] Configure root `package.json` with strict `files` whitelist (`dist/src`, `README.md`, `LICENSE`), `main`, `types`, and export maps
- [x] Relocate `FakeEngine` to `src/contracts/fake-engine.ts` making `dist/src` 100% self-contained
- [x] Fix CLI executable invocation for symlinked binaries using `realpathSync` in `src/index.ts`
- [x] Add comprehensive minimizer unit test suite (`tests/unit/minimizer.test.ts`) — 13 tests
- [x] Add tarball packing and consumer installation integration test (`tests/integration/package-distribution.test.ts`) — 3 tests
- [x] Verify full test suites: 101/101 TypeScript tests, 4/4 Python tests, website build clean
- [x] Update `.github/workflows/ci.yml` with npm pack dry-run and Python test execution
- [x] Verify `git diff --check` passes with zero formatting issues

## Step 6: Standalone Offline HTML Reports & GitHub Actions Integration

- [x] Implement self-contained offline interactive HTML report in `src/reports/html-report.ts`
- [x] Ensure zero external network/CDN/font dependencies and full XSS mitigation (`escapeHtml`, safe JSON embedding)
- [x] Include interactive search, status filtering, noisy sampling metrics, candidate boundary verification, and hash-chain audit viewer
- [x] Implement GitHub Actions step summary generation and atomic file append in `src/reports/github-summary.ts`
- [x] Implement GitHub Issue & Pull-Request Markdown exporter (`generateGitHubIssueMarkdown`)
- [x] Update `writeSessionReportArtifacts` to write `report.html` and append to `$GITHUB_STEP_SUMMARY` automatically
- [x] Add CLI options to `bisectpilot report`: `--html`, `--github-summary [file]`, `--github-issue`, `--out <file>`
- [x] Add 13 unit tests across `tests/unit/html-report.test.ts` and `tests/unit/github-summary.test.ts` (114/114 total passing)
- [x] Verify package packing (93 files, 89.6 kB) and consumer installation in isolated workspace
- [x] Update README, documentation, and verify `git diff --check` clean

## Step 7: Monorepo & Multi-Package Workspace Bisection

- [x] Implement safe workspace path validation (`validateWorkspacePath`) preventing path escapes and symlink jailbreaks in `src/domain/workspace.ts`
- [x] Implement path scope calculation (`resolveWorkspacePathScope`) including workspace directory and root manifest/lockfile files
- [x] Implement monorepo lockfile and dependency manifest detection & SHA-256 hashing (`detectWorkspaceDependencies`)
- [x] Extend `BisectConfigV1` with `workingDirectory` and `pathScope` validation in `src/contracts/config.ts`
- [x] Pass path scope directly to native `git bisect start <bad> <good> -- <paths...>` without shell concatenation
- [x] Propagate workspace working directory to oracle step execution while keeping Git repository root intact
- [x] Safely skip historical commits prior to workspace directory creation with reason `untestable_revision`
- [x] Record workspace dependency hashes and metadata into hash-chained ledger and session reports
- [x] Update standalone reproduction script (`repro.sh`) to `cd` into the package workspace within temporary worktree

## Step 8: Performance Regression & Benchmark Bisection

- [x] Implement pure statistical computation in `src/domain/statistics.ts` (`calculateSampleStats`, `calculatePercentile`, `logGamma`, `regularizedIncompleteBeta`, `calculateStudentsTPValue`, `welchTTest`)
- [x] Implement benchmark extraction & regression detection in `src/domain/benchmark.ts` (`parseBenchmarkMetric`, `buildBenchmarkStats`, `evaluateBenchmarkRegression`)
- [x] Support flat and nested JSON, key-value text, and regex patterns with strict unit checking and NaN/Infinity rejection
- [x] Implement warm-up sample discarding and sequential early stopping on statistical significance
- [x] Extend contracts (`BenchmarkSpec`, `BenchmarkStats`, `BenchmarkEvaluationResult`, `profile: "performance"`, benchmark reason codes)
- [x] Extend `SessionManifestV1` with `benchmarkBaseline` established during good endpoint preflight
- [x] Validate bad endpoint regression during preflight and candidate/parent boundary confirmation
- [x] Record comprehensive benchmark telemetry into hash-chained ledger on `revision_classified` events
- [x] Surface benchmark performance summaries across JSON, Markdown, HTML, and GitHub Actions step summaries
- [x] Expose CLI options `--metric`, `--threshold`, `--relative-regression`, `--direction`, `--warmup`, `--samples`, `--min-samples`, `--max-samples`, `--alpha`, `--unit` on `plan`, `start`, `run`
- [x] Add statistical unit tests (`tests/unit/statistics.test.ts`) — 10 tests
- [x] Add benchmark unit tests (`tests/unit/benchmark.test.ts`) — 13 tests
- [x] Add real-Git benchmark bisection integration test (`tests/integration/benchmark-bisect.test.ts`) — 1 test
- [x] Verify full test suites: 158/158 TypeScript tests passing, 4/4 Python tests passing, clean package distribution (102 files, 114.2 kB), clean `git diff --check`

## Step 9: Daemon, Durable Jobs & Distributed Workers

- [x] Freeze typed job, worker capability, protocol and transition contracts without changing existing bisect contracts unnecessarily
- [x] Implement atomic durable queue with validated transitions, stable attempts, idempotent results and conservative lease recovery
- [x] Implement daemon lifecycle, authenticated bounded HTTP protocol, status, shutdown, enqueue, cancellation and explicit recovery
- [x] Implement pull worker lifecycle, pre-provisioned repository validation, heartbeat, cancellation and existing-engine execution
- [x] Add `start --background`, reports/status metadata and focused documentation without changing foreground behavior
- [x] Add unit and loopback integration tests for auth, invalid input, leases, recovery, cancellation and repository capability mismatch
- [x] Run targeted tests, full TypeScript/Python suites, package dry-run and `git diff --check`; report remote-machine limits honestly

## Step 10: Rootless Container Sandbox & Untrusted Commit Execution

- [x] Freeze the opt-in sandbox policy contract and strict validation without changing default direct execution
- [x] Implement injected Docker/Podman runtime discovery, rootless/image/isolation preflight and owned container lifecycle
- [x] Integrate sandbox execution at the process/oracle boundary with safe mounts, no-network policy, resource limits, cancellation and bounded output
- [x] Add worker capability matching and async-job rejection for unavailable or unsafe sandbox requests
- [x] Add deterministic security/lifecycle tests and an explicitly skipped-or-real runtime integration test
- [x] Update CLI/docs/ledger evidence and run targeted/full regression, package and diff checks

## Step 11: Mutual TLS, Remote Workers & Production Security

- [x] Implement mutual TLS (mTLS) for daemon and pull workers (`node:tls`, `node:https`) with bidirectional certificate verification
- [x] Enforce mandatory mTLS and reject plain HTTP for remote/non-loopback daemon binds and worker connections
- [x] Verify client certificate Subject CN and SHA-256 fingerprint; bind authenticated remote requests to verified worker identity
- [x] Implement dynamic certificate rotation (`rotateServerTls`, `rotateTlsCredentials`) and instant fingerprint/worker revocation
- [x] Prevent cross-worker lease submission, heartbeat hijacking, stale attempt results, and unassigned job claims
- [x] Add Linux CI step in `.github/workflows/ci.yml` verifying rootless Podman execution with a digest-pinned image
- [x] Add comprehensive mTLS integration tests (`tests/integration/mtls-remote-worker.test.ts`) across 10 distinct security scenarios
- [x] Verify full regression suites (186/186 TS tests passing, 4/4 Python tests passing, package distribution clean, `git diff --check` clean)

## Step 12: Production Observability, OpenTelemetry & Prometheus Metrics

- [x] Define OpenTelemetry-compatible tracing interface (`TraceContext`, W3C `traceparent`, `Tracer`, `Span`, `SpanExporter`, `InMemorySpanExporter`) in `src/telemetry/tracing.ts`
- [x] Implement Prometheus text exposition metrics registry (`Counter`, `Gauge`, `Histogram`, `MetricsRegistry`, `defaultMetrics`) in `src/telemetry/metrics.ts`
- [x] Implement tamper-evident audit event exporter (`AuditEventExporter`, `FileAuditEventExporter`, `WebhookAuditEventExporter`, `InMemoryAuditEventExporter`) in `src/telemetry/audit-exporter.ts`
- [x] Expose secure `/metrics` endpoint on daemon with loopback/TLS authentication boundaries and bounded response in `src/daemon/index.ts`
- [x] Wire metrics and trace context into daemon queue lifecycle (`src/jobs/index.ts`, `src/daemon/index.ts`)
- [x] Wire metrics and trace context into worker lifecycle (`src/worker/index.ts`, `src/daemon/client.ts`)
- [x] Wire metrics and tracing into bisection engine, oracle, benchmark, and sandbox lifecycle (`src/application/index.ts`, `src/oracle/index.ts`, `src/adapters/process/sandbox-runtime.ts`)
- [x] Extend daemon status diagnostics with telemetry metadata in `src/daemon/index.ts`
- [x] Export telemetry APIs via `src/telemetry/index.ts` and `src/index.ts`
- [x] Add unit, integration, and security tests for tracing, Prometheus metrics, `/metrics` endpoint security, and audit export (`tests/unit/telemetry.test.ts`, `tests/integration/telemetry-metrics.test.ts`)
- [x] Run full test suites (`npm test`, `npm run test:py`, `npm pack --dry-run`, `git diff --check`)
- [x] Update documentation (`AI_BRAIN.md`, `SESSION_MEMORY.md`, `README.md`, `docs/architecture.md`, `docs/safety-model.md`, `docs/handoff.md`)

## Step 13: Distributed Bisection Fleet & Multi-Worker Coordination

- [x] Feature A: Worker capability matching & bounded scheduling (`JobType`, `fencingToken`, `requiredCapabilities`, `supportedProfiles`, `features`, `environmentIdentity`, `maxConcurrentJobs`)
- [x] Feature B: Lease fencing & authoritative result acceptance (monotonically incrementing `fencingToken`, strict attempt matching, rejection of stale/expired/cross-worker results, duplicate idempotency)
- [x] Feature C: Parallel noisy-oracle sampling (`FleetCoordinator.scheduleNoisyOracleBatch`, bounded sample jobs, Bayesian SPRT early stopping, cancellation of unneeded samples)
- [x] Feature D: Parallel benchmark execution (`FleetCoordinator.scheduleBenchmarkBatch`, pinned `environmentIdentity`, Welch's t-test evaluation, deterministic aggregation)
- [x] Feature E: Preservation of native Git Bisect sequential search as safe default, avoiding racing search boundary transitions
- [x] Feature F: Worker loss, cancellation, and rollback (graceful batch cancellation, isolated resource release, safe failure transitions)
- [x] Feature G: Fleet observability (bounded Prometheus metrics for scheduling delay, stale result rejection reasons, sample counts, worker concurrency gauges, W3C traceparent propagation)
- [x] Add comprehensive unit and integration tests (`tests/unit/fleet-coordinator.test.ts`, `tests/integration/fleet-coordination.test.ts`)
- [x] Verify full regression suites (`npm test` 213 tests passing, `npm run test:py` 4/4 passing, package distribution clean, `git diff --check` clean)

## Step 14: Automated Session Recovery, Master-Plan Audit & Release Readiness

- [x] Feature A: Durable session checkpointing & write-ahead log (WAL) synchronization (`src/session/checkpoint.ts`, `checkpoint.json`, `checkpoint.backup.json`, atomic rename, checksum calculation)
- [x] Feature B: Deterministic tri-level fallback recovery (`primary` -> `backup` -> `reconstructed_from_wal` via hash-chained `events.jsonl`)
- [x] Feature C: Fast resume semantics (cached authoritative classifications in checkpoint are reused instantly by `executeSingleBisectStep`, skipping live test re-execution)
- [x] Feature D: Daemon crash recovery (`DaemonService.recoverActiveSessions()` discovers dead-process sessions on startup, reconciles state, transitions to `needs_recovery`)
- [x] Feature E: Non-parametric statistical comparison for heavy-tailed benchmark distributions (`mannWhitneyUTest`, `erf` in `src/domain/statistics.ts`)
- [x] Feature F: Observability visualization provisioning template (`docs/grafana-dashboard.json`)
- [x] Feature G: Unit and integration test suites (`tests/unit/session-recovery.test.ts`, `tests/integration/session-resume-recovery.test.ts`)
- [x] Feature H: Full master-plan audit against `docs/bisectpilot-master-plan-v3.md` (Sections 19–29, traceability matrix, safety guarantees)
- [x] Feature I: Complete test and release artifact verification (`npm test` 229 tests across 29 suites with 228 passing and 1 skipped on macOS, `npm run test:py` 4/4 passing, package dry-run and isolated installation 3/3 passing, `website` 8/8 static pages passing, `git diff --check` clean)

## Release Verification Milestone — P1 Blockers & Cross-Platform Hardening

- [x] Fresh-clone end-to-end bisection functional proof (`tests/integration/fresh-clone-e2e.test.ts` — planted regression c3 found, JSON/MD/HTML report consistency, HTML XSS escaping, timeout safety, skip budget enforcement)
- [x] P1.3: Checkpoint durability guarantees (`fsyncSync` temporary file & directory synchronization on POSIX in `src/session/checkpoint.ts`)
- [x] P1.4: Process-kill (SIGKILL) crash tests at persistence write points (`tests/integration/session-resume-recovery.test.ts`)
- [x] P1.5: Unsupported checkpoint schema version (schemaVersion: 99) and wrong-repository checkpoint rejection tests (`tests/integration/session-resume-recovery.test.ts`)
- [x] P1.6: Document `needs_recovery` lifecycle, safe inspection, resume commands, and blocked-recovery conditions (`src/cli/index.ts`, `README.md`, `docs/architecture.md`, `docs/safety-model.md`)
- [x] P1.2: Multi-machine mTLS execution runbook & test harness (`docs/multimachine-mtls-setup.md`, `tests/integration/mtls-remote-worker.test.ts` 10/10 automated tests pass; Physical multi-machine deployment: `BLOCKED` / `UNVERIFIED` due to lack of 2nd physical machine)
- [x] P1.1: Genuine Linux, macOS & Windows CI execution (Passed on GitHub Actions run 39463385230 across ubuntu-latest, macos-latest, windows-latest on Node 20.x & 22.x; rootless Podman verified on Linux runner; native Windows execution verified)

## Step 15: GitHub CI/CD, Master Branch Discipline & Security Hardening

- [x] Fix cross-platform test discovery in `scripts/run-tests.mjs` and add regression suite `tests/unit/test-discovery.test.ts`
- [x] Fix Windows runner test compatibility (cmd.exe quoting, Node ESM pathToFileURL, 8.3 path canonicalization, exit code assertions)
- [x] Enhance Podman rootless sandbox inspect parsing in `src/adapters/process/sandbox-runtime.ts` for expanded CapDrop, string Entrypoint, and un-delegated cgroup limits
- [x] Fix bisect output parsing for quoted git terms and direct 0-intermediate candidate resolution in `src/application/index.ts`
- [x] Add CLI `--version` and `-v` handlers in `src/cli/index.ts`
- [x] Build and verify cross-platform CI matrix workflow `.github/workflows/ci.yml` (Linux, macOS, Windows on Node 20.x and 22.x)
- [x] Add GitHub CodeQL static application security analysis workflow `.github/workflows/codeql.yml` (JS/TS & Python) — 0 alerts (run 39463385096)
- [x] Add Gitleaks secret scanning workflow `.github/workflows/secret-scanning.yml` & `.gitleaks.toml` — 0 leaks (run 39463385058)
- [x] Configure Dependabot in `.github/dependabot.yml` for npm (root & website), GitHub Actions, and pip
- [x] Validate package integrity, isolated consumer installation, CLI execution, and SPDX SBOM generation (`npm sbom --sbom-format=spdx`)
- [x] Configure gated GitHub Packages publish workflow `.github/workflows/publish.yml` for `@priyanshu2007-cmd/bisectpilot`
- [x] Enforce master-only branch policy with full offline backup bundle preserved

## P2 — Deferred Post-Release Items

- [ ] P2.1: Optional OpenTelemetry Collector OTLP exporter (W3C traceparent and Prometheus /metrics exist)
- [ ] P2.2: Website workspace / package-scope indicator in Explorer specimen
- [ ] P2.3: Deeper native Windows process-tree (`taskkill.exe`) and daemon recovery tests
- [ ] P2.4: Open-source community files (CHANGELOG, CONTRIBUTING, issue templates, npm provenance preparation)
