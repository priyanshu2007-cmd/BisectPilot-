# SESSION MEMORY

Use this file for temporary task-specific context.

It prevents `AI_BRAIN.md` from becoming bloated.

## Current Goal

Complete Release Verification Milestone & Cross-Platform Hardening:
- Verify fresh-clone isolated end-to-end bisection (`tests/integration/fresh-clone-e2e.test.ts`).
- Execute and resolve P1 requirements (durability `fsyncSync`, process-kill SIGKILL crash tests, unsupported schema & wrong-repo rejection, CLI recovery documentation, multi-machine mTLS runbook).
- Audit cross-platform status and declare verified blockers (Windows `skills ` trailing space, Linux rootless Podman CI).
- Provide evidence-based status: `NOT_READY_BLOCKERS_REMAIN`.

## Release Verification Working Context

- Fresh-clone bisection proof: isolated cloned repository with planted regression (`c3`), good (`c1`) and bad (`c4`) bounds, report consistency (JSON/MD/HTML), XSS escaping, timeout safety, and skip budget enforcement. All 3 tests pass.
- Checkpoint durability: `src/session/checkpoint.ts` implements `fsyncSync` of temporary checkpoint files and directory metadata on POSIX. Process-crash consistency is 100% guaranteed; power loss is best-effort.
- Subprocess SIGKILL crash tests: parent kills child process during active bisection; resume cleanly recovers state from checkpoint cache and finishes bisection to identical culprit.
- Schema & Repo rejection: `schemaVersion: 99` rejects cleanly and recovers from WAL; wrong `commonGitDir` checkpoint aborts before mutating worktrees.
- Multi-machine mTLS: `docs/multimachine-mtls-setup.md` provides full PKI generation, daemon and remote worker setup, fencing token validation, and network partition simulation. Loopback passes 10/10 tests; real physical deployment is marked `BLOCKED` / `UNVERIFIED`.
- Recovery CLI documentation: `HELP_TEXT` updated with `needs_recovery`, `status`, and `resume` commands and blocked recovery conditions.

## Files Modified in Step 8

- Statistics Domain: `src/domain/statistics.ts` (`calculateSampleStats`, `calculatePercentile`, `logGamma`, `regularizedIncompleteBeta`, `calculateStudentsTPValue`, `welchTTest`).
- Benchmark Domain: `src/domain/benchmark.ts` (`parseBenchmarkMetric`, `buildBenchmarkStats`, `evaluateBenchmarkRegression`, `BenchmarkSpec`, `BenchmarkStats`, `BenchmarkEvaluationResult`).
- Domain Index: `src/domain/index.ts` (exported `statistics.js` and `benchmark.js`).
- Config Contract: `src/contracts/config.ts` (added `"performance"` to `RegressionProfile`, defined `BenchmarkSpec`, `BenchmarkDirection`, updated `BisectConfigV1` and `validateConfig`).
- Outcome Contract: `src/contracts/outcome.ts` (added benchmark reason codes `benchmark_regression_detected`, `benchmark_within_tolerance`, etc., and `benchmark` field).
- Ledger Contract: `src/contracts/ledger.ts` (added `benchmark?: BenchmarkSpec` to `SessionCreatedEvent` and detailed benchmark metrics to `RevisionClassifiedEvent.benchmark`).
- Session Contract: `src/contracts/session.ts` (added `benchmarkBaseline?: BenchmarkStats` to `SessionManifestV1`).
- Application Engine: `src/application/index.ts` (preflight good endpoint baseline collection, bad endpoint regression validation, git checkout and reset).
- Oracle Executor: `src/oracle/index.ts` (warmup run discarding, sample collection, sequential early stopping on Welch's t-test significance, ledger event recording).
- Bisect Runner: `src/runner/bisect-runner.ts` (pass `manifest.benchmarkBaseline` to `evaluateCheckedOutRevision`).
- Reports & Repro: `src/reports/index.ts` (benchmark summary in JSON and Markdown reports).
- HTML Report: `src/reports/html-report.ts` (Benchmark Metric tile in executive summary).
- GitHub Summary: `src/reports/github-summary.ts` (Benchmark Metric row in Key Findings table).
- CLI Parser: `src/cli/index.ts` (CLI options `--metric`, `--threshold`, `--relative-regression`, `--direction`, `--warmup`, `--samples`, `--min-samples`, `--max-samples`, `--alpha`, `--unit`).
- Tests: `tests/unit/statistics.test.ts` (10 tests), `tests/unit/benchmark.test.ts` (13 tests), `tests/integration/benchmark-bisect.test.ts` (1 integration test with real Git fixture).
- Documentation: `README.md`, `AI_BRAIN.md`, `SESSION_MEMORY.md`, `tasks/todo.md`, `docs/architecture.md`, `docs/handoff.md`.

## Step 9 Files & Verification

- Contracts/queue: `src/contracts/jobs.ts`, `src/jobs/index.ts` — typed payloads, validated transition history, atomic snapshots, leases, attempts, cancellation, idempotency and conservative recovery.
- Daemon: `src/daemon/index.ts`, `src/daemon/client.ts`, `src/daemon/cli.ts` — authenticated bounded HTTP, loopback/TLS policy, lifecycle, queue protocol and daemon ownership lock.
- Worker: `src/worker/index.ts`, `src/worker/cli.ts` — outbound polling, pre-provisioned repository/path/SHA validation, heartbeat, cancellation and existing-engine execution.
- Tests: `tests/unit/jobs.test.ts`, `tests/unit/daemon.test.ts`, `tests/integration/daemon-worker.test.ts`.
- Docs/memory: `README.md`, `docs/architecture.md`, `docs/safety-model.md`, `docs/handoff.md`, `AI_BRAIN.md`, `SESSION_MEMORY.md`, `tasks/plan.md`, `tasks/todo.md`.

Latest verification:
- TypeScript: `npm test` -> 168/168 tests passed across 16 suites.
- Python: `npm run test:py` -> 4/4 tests passed.
- Packaging: `npm pack --dry-run` -> 123 files, 149.2 kB tarball size.
- Format: `git diff --check` -> 0 formatting issues.
- Manual: detached daemon and worker start/status/stop lifecycle checks passed.
- Limitation: remote TLS, separate-machine workers and Windows behavior remain untested.

## Step 11 Working Context

- Protocol & Transport: Bidirectional mutual TLS over `node:https`/`node:tls`. Worker verifies server cert and hostname; daemon enforces `requestCert: true`, `rejectUnauthorized: true`. Zero tolerance for `rejectUnauthorized: false`.
- Network boundaries: Non-loopback daemon binds require TLS cert, key, and CA. Client rejects plain HTTP for non-loopback URLs. POSIX key permissions must be 0o600.
- Worker Authorization: Peer certificate Subject CN is extracted and verified against claimed `workerId`. Allowlist of identities and SHA-256 fingerprints is enforced.
- Revocation: In-flight SHA-256 fingerprint check on every request over established TLS connections. Admin endpoint `/v1/admin/revoke` and CLI `bisectpilot daemon revoke` persist revocations to `revocations.json`.
- Dynamic Rotation: Zero-downtime server TLS context update via `server.setSecureContext()` and client credential rotation via `client.rotateTlsCredentials()`, with pre-validation via `tls.createSecureContext()`.
- Rootless Container CI: Added Linux workflow step in `.github/workflows/ci.yml` using `podman` on `ubuntu-latest` with digest-pinned `alpine:latest`.

## Step 12 Working Context: Production Observability, OpenTelemetry & Prometheus Metrics

- Tracing Architecture: Native W3C Trace Context (`traceparent` header `00-${traceId}-${spanId}-${flags}`) parser and formatter with zero external dependencies. `Tracer`, `Span`, `SimpleTracer` using `AsyncLocalStorage`, `InMemorySpanExporter`, `NoopTracer`. Built-in attribute sanitization redacting tokens, keys, secrets, passwords, cookies, and certificates.
- Prometheus Exposition: Prometheus 0.0.4 text format generated from lightweight `MetricsRegistry`, `Counter`, `Gauge` (bounded >= 0), and `Histogram` with default standard latency/duration buckets and cumulative observations.
- Security Boundary: `/metrics` bound directly to daemon HTTP/HTTPS server. Loopback calls allowed directly; remote calls strictly enforced with mutual TLS client certificates and Bearer token authorization. Never leaks secrets or unbound session IDs/commits.
- Lifecycle Events Instrumented:
  - Queue: `bisectpilot_queue_depth`, `bisectpilot_active_jobs`, `bisectpilot_jobs_total`, `bisectpilot_active_leases`, `bisectpilot_lease_renewal_failures_total`, `bisectpilot_expired_leases_total`, `bisectpilot_queue_waiting_duration_seconds`, `bisectpilot_job_execution_duration_seconds`.
  - Workers: `bisectpilot_registered_workers` (available/busy).
  - Engine/Oracle: `bisectpilot_active_sessions`, `bisectpilot_revision_evaluations_total`, `bisectpilot_revisions_classified_total`, `bisectpilot_oracle_execution_duration_seconds`, `bisectpilot_candidate_boundary_verifications_total`, `bisectpilot_benchmark_samples_total`, `bisectpilot_benchmark_evaluation_duration_seconds`.
  - Sandbox: `bisectpilot_sandbox_preflight_failures_total`, `bisectpilot_container_execution_duration_seconds`.
  - Reliability: `bisectpilot_process_timeouts_total`, `bisectpilot_cancellations_total`, `bisectpilot_process_execution_failures_total`, `bisectpilot_recovery_required_sessions_total`, `bisectpilot_report_generation_failures_total`.
- Audit Export: `AuditEventExporter` interface with `InMemoryAuditEventExporter`, `FileAuditEventExporter`, and `WebhookAuditEventExporter`. Verifies tamper-evident ledger hash chain before exporting; rejects corrupted chains; prevents recursive telemetry loops.
- Diagnostics: Daemon `/v1/status` augmented with `telemetry` (metricsEndpoint, tracingEnabled, registeredMetricsCount).

Latest Verification (Release Hardening Milestone):
- `npm run build`: Compiled TypeScript with 0 errors (`tsc -p tsconfig.json`).
- `npm test`: 229 tests across 29 suites (228 passed, 1 skipped on macOS for missing rootless container runtime, 0 failed, 14.7s).
- `npm run test:py`: 4/4 tests passed (0.004s).
- `node --test dist/tests/integration/package-distribution.test.js`: 3/3 passed (tarball creation, isolated external install, binary execution).
- `npm pack --dry-run`: 144 files, 211.8 kB compressed, 1.1 MB unpacked.
- `npm --prefix website run test`: 8/8 static pages rendered, 0 lint errors, Next.js build clean.
- `git diff --check`: 0 formatting or whitespace issues.
- Decision: `NOT_READY_BLOCKERS_REMAIN` (Windows checkout blocked by `skills ` trailing space; Linux rootless Podman CI unconfigured; multi-machine mTLS physical hardware unverified).
