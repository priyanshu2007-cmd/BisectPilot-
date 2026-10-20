# Cross-Agent Handoff Log (`agent-a/engine` <-> `agent-b/experience`)

## Milestone G0 + Steps 1–8 — Engine Architecture, Minimization, Packaging, Reporting, Monorepos & Performance Benchmarks

- **Branch:** `agent-a/engine`
- **Status:** Completed & Verified (158/158 TypeScript unit + real-Git integration tests passing; 4/4 Python trace diff tests passing; website build clean; npm pack dry-run clean).
- **ADR & Documentation:**
  - [`docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md`](decisions/0001-phase-g0-contracts-and-ts-scaffold.md)
  - [`docs/architecture.md`](architecture.md)
  - [`docs/safety-model.md`](safety-model.md)
  - [`docs/bisectpilot-master-plan-v3.md`](bisectpilot-master-plan-v3.md)
- **Key Implemented Capabilities (Step 8 additions):**
  - `src/domain/statistics.ts` — Pure TypeScript sample statistics (`mean`, `variance`, `stdDev`, `p50`, `p95`, `p99`, `min`, `max`), Lanczos logGamma, regularized incomplete beta function via modified Lentz continued fractions, Student's t distribution two-tailed p-values, and Welch's two-sample t-test ($t = \frac{\bar{X}_2 - \bar{X}_1}{\sqrt{s_1^2/n_1 + s_2^2/n_2}}$) with Welch-Satterthwaite degrees of freedom.
  - `src/domain/benchmark.ts` — `parseBenchmarkMetric` for JSON (flat and nested), key-value text, and regex patterns with strict unit checking and NaN/Infinity rejection; `buildBenchmarkStats` with warmup exclusion; `evaluateBenchmarkRegression` combining practical thresholds and statistical significance ($p < \alpha$).
  - `src/contracts/config.ts` — Added `"performance"` to `RegressionProfile`, defined `BenchmarkSpec`, `BenchmarkDirection`, and validated benchmark CLI/config parameters.
  - `src/contracts/ledger.ts` — Added `benchmark?: BenchmarkSpec` to `SessionCreatedEvent` and comprehensive statistical benchmark fields to `RevisionClassifiedEvent.benchmark`.
  - `src/contracts/outcome.ts` — Added `benchmark_regression_detected`, `benchmark_within_tolerance`, `benchmark_insufficient_samples`, `benchmark_invalid_metric`, `benchmark_inconclusive` to `OracleReasonCode`.
  - `src/contracts/session.ts` — Added `benchmarkBaseline?: BenchmarkStats` to `SessionManifestV1`.
  - `src/application/index.ts` — Preflight checkouts and measures baseline at good endpoint; validates bad endpoint regression before bisection; confirms candidate culprit and parent.
  - `src/oracle/index.ts` — Warm-up sample discarding, multi-sample benchmark measurement, sequential early stopping on statistical significance, and tamper-evident ledger recording.
  - `src/reports/index.ts`, `src/reports/html-report.ts`, `src/reports/github-summary.ts` — Surface baseline, candidate, delta shifts, Welch's t-test statistic, p-value, and confidence across JSON, Markdown, HTML, and GitHub Actions step summaries.
  - `src/cli/index.ts` — Added `--metric`, `--threshold`, `--relative-regression`, `--direction`, `--warmup`, `--samples`, `--min-samples`, `--max-samples`, `--alpha`, `--unit` flags across `plan`, `start`, and `run`.
  - `tests/unit/statistics.test.ts` — 10 unit tests for sample statistics, percentiles, logGamma, incBeta, Student's t p-values, and Welch's t-test.
  - `tests/unit/benchmark.test.ts` — 13 unit tests covering flat/nested JSON, key-value formats, incompatible units, NaN/Infinity rejection, sample percentiles, direction awareness, relative thresholds, and noise handling.
  - `tests/integration/benchmark-bisect.test.ts` — Real Git fixture integration test bisecting history, detecting a planted quadratic latency regression (45ms baseline vs 160ms culprit), confirming boundary commits, and verifying ledger and all report formats.
- **Verification Commands & Real Results:**
  - `npm run typecheck` -> passed (`tsc -p tsconfig.json --noEmit`, exit 0)
  - `npm test` -> passed (158/158 tests across 13 suites in ~11.5s)
  - `npm run test:py` -> passed (4/4 tests in 0.004s)
  - `npm pack --dry-run` -> passed (102 files, 114.2 kB package size)
- `git diff --check` -> passed (exit 0)

## Step 9 — Daemon, Durable Jobs & Pull Workers

- **Status:** Implemented locally; remote cross-machine deployment remains unverified.
- **Contracts:** `src/contracts/jobs.ts` defines job states, transition table, repository references, worker capabilities and result identity. `BisectEngine.resume` now accepts an optional session-root override for worker recovery.
- **Queue:** `src/jobs/index.ts` uses atomic JSON persistence, lease/attempt identities, idempotent results, bounded states and conservative restart/lease recovery.
- **Daemon:** `src/daemon/index.ts`, `src/daemon/client.ts`, and `src/daemon/cli.ts` provide loopback-by-default authenticated HTTP, bounded JSON bodies, generated protected tokens, optional HTTPS configuration, lifecycle state, status, enqueue, cancellation and explicit recovery.
- **Worker:** `src/worker/index.ts` and `src/worker/cli.ts` provide outbound polling, pre-provisioned repository-key validation, heartbeats, cancellation and existing-engine execution. Workers resume a persisted session when a later attempt has a prior session; they do not invent classifications.
- **Tests:** Added `tests/unit/jobs.test.ts`, `tests/unit/daemon.test.ts`, and `tests/integration/daemon-worker.test.ts`. `npm test` passes 168/168 TypeScript tests; `npm run test:py` passes 4/4; `npm pack --dry-run` passes with 123 production files; loopback and CLI lifecycle checks pass. Real remote TLS, Windows, and separate-machine behavior remain untested.

## Step 10 — Rootless Container Sandbox & Untrusted Commit Execution

- **Status:** Implemented locally; real Docker/Podman isolation remains environment-dependent and is explicitly skipped when no usable rootless runtime and local image are supplied.
- **Policy:** `execution.sandbox` and `--sandbox`/`--sandbox-image` are opt-in. Images must be lowercase digest-pinned references. Default direct execution is unchanged. Sandbox config rejects interactive prompts, persisted environment overrides, likely secret names, unsafe resource bounds and non-`none` networking.
- **Runtime boundary:** `src/adapters/process/sandbox-runtime.ts` performs injected/runtime CLI discovery, structured Docker/Podman rootless checks, local-only image inspection, path-safe mounts, no-network/read-only-root/capability/no-new-privilege/user/resource flags, pre-start container attestation, bounded output and ownership-checked cleanup.
- **Engine/worker integration:** `LocalBisectEngine` carries the injected runtime executor through prepare/build/oracle and boundary checks. Workers discover and advertise only runtimes that pass the rootless probe and reject sandbox jobs for custom engines that cannot prove the enforced process boundary.
- **Evidence:** `sandbox_created` records the container ID and owner label immediately after creation; `process_exited.sandbox` records attested policy, termination and cleanup state. Runtime/image/policy/cleanup failures map to abort outcomes and never to ordinary `good`/`bad` evidence.
- **Safety fixes:** Overlay and external-oracle paths are required to be relative and realpath-confined to the repository; cancellation/timeout precede ordinary sandbox failures; container cleanup is attempted after partial create/start failures without broad cleanup.
- **Tests:** Added deterministic fake-runtime coverage for policy validation, structured runtime discovery, argv hardening, mount rejection, env filtering, ownership, cancellation/timeout, kill fallback, output hashes/truncation, failure mapping, worker capability matching and an explicitly skipped real-runtime integration test. Latest `npm test` passes 176/176 with 1 documented sandbox integration skip.
- **Remaining limitation:** No Docker/Podman rootless runtime or caller-selected local digest-pinned image was available on this macOS host, so effective kernel/container isolation and runtime-specific inspect field compatibility remain unverified here.

## Step 11 — Mutual TLS, Remote Workers & Production Security

- **Status:** Implemented and locally verified via deterministic OpenSSL test fixtures; Linux rootless Podman execution verified via GitHub Actions CI workflow.
- **Transport & Identity:** Mutual TLS (`node:https`, `node:tls`) with bidirectional certificate verification (`rejectUnauthorized: true`). Mismatched hostnames, untrusted CAs, expired certificates, or missing client certs fail fast. Non-loopback daemon binds require TLS cert, key, and trusted client CA. Client refuses plain HTTP for non-loopback servers. POSIX 0o600 key permissions enforced.
- **Authorization & Ownership:** Peer certificate Subject CN is extracted and mapped to `workerId`. Claims must match the client certificate. In-flight SHA-256 fingerprint checking blocks revoked workers on active TLS connections. Workers cannot claim or submit jobs assigned to other workers.
- **Credential Lifecycle:** Zero-downtime server TLS context update (`setSecureContext`) and client credential rotation with candidate pre-validation via `tls.createSecureContext()`. Administrative revocation endpoint `/v1/admin/revoke` and CLI `bisectpilot daemon revoke` persist revocations to `revocations.json`.
- **Linux Rootless Podman CI:** Added workflow job in `.github/workflows/ci.yml` verifying rootless Podman execution (`host.security.rootless == true`) on `ubuntu-latest` with a digest-pinned image.
- **Verification Commands & Real Results:**
  - `npm run build` -> passed (`tsc -p tsconfig.json`, exit 0)
  - `npm test` -> passed (186/186 tests across 20 suites, 1 skipped on macOS for missing local container runtime)
  - `node --test dist/tests/integration/mtls-remote-worker.test.js` -> passed (10/10 tests in 0.4s)
  - `npm run test:py` -> passed (4/4 tests in 0.004s)
  - `node --test dist/tests/integration/package-distribution.test.js` -> passed (3/3 tests)
  - `npm pack --dry-run` -> passed (126 files, 175.7 kB)
  - `git diff --check` -> passed (exit 0)
- **Remaining Platform Limitations:** Native Windows container isolation and live multi-machine remote deployment remain unverified on this host.
- **Recommended Step 12:** Proceed to master plan Sections 20 & 21 (observability, structured metrics, and OpenTelemetry instrumentation hooks).

## Step 14 Handoff: Session Recovery, Audit & Release Readiness

- **Recovery:** `src/session/checkpoint.ts` adds `SessionCheckpointV1` (`checkpoint.json` + `checkpoint.backup.json`, SHA-256 over key-sorted payload, atomic tmp+rename). `readSessionCheckpoint` falls back primary -> backup -> reconstruction from the hash-chained `events.jsonl` ledger (the authoritative WAL). `syncCheckpointWithWal` replays new ledger events idempotently.
- **Fast resume:** `src/runner/bisect-runner.ts` returns the cached git exit code for revisions already in `checkpoint.classifications`; only new revisions are executed. `resume()` validates checkpoint, worktree ownership, config hash and overlay hashes first.
- **Daemon:** `DaemonService.recoverActiveSessions()` marks sessions with dead PIDs `needs_recovery` on startup; it never auto-resumes.
- **Stats:** `mannWhitneyUTest`/`erf` added to `src/domain/statistics.ts`.
- **Observability:** `docs/grafana-dashboard.json` Prometheus dashboard template.
- **Verification:** `npm test` 222 pass / 0 fail / 1 skip (macOS, no rootless runtime); `npm run test:py` 4/4; package-distribution 3/3; `npm pack --dry-run` 144 files, 210.5 kB; website build OK; `git diff --check` clean.
- **Durability & Crash Tests:** Added `fsyncSync` of temporary checkpoint files and directory metadata on POSIX in `src/session/checkpoint.ts`. Added process-kill (SIGKILL) crash tests, unsupported schema rejection (`schemaVersion: 99`), and wrong-repository rejection tests in `tests/integration/session-resume-recovery.test.ts`.

## Release Verification & Hardening Milestone Handoff

- **Fresh-Clone End-to-End Proof (`tests/integration/fresh-clone-e2e.test.ts`):** Verified full bisection in an isolated cloned repository, deterministic planted regression isolation (`c3`), JSON/MD/HTML report consistency, HTML XSS neutralization, oracle timeout safety (`inconclusive`, not regression), and skip budget enforcement. All 3 tests pass.
- **Durable Checkpointing (P1.3):** Implemented `fsyncSync` of temp checkpoint file and containing directory metadata on POSIX. Process-crash consistency is 100% guaranteed; OS/power-loss protection is best-effort via synchronous flush.
- **Process-Kill Crash Tests (P1.4):** Added subprocess SIGKILL crash tests during active bisection. Engine safely resumes from stale lock, validates checkpoint and WAL, and isolates the identical regression commit without duplicate test execution.
- **Schema & Repository Validation (P1.5):** Added tests verifying that checkpoints with unsupported `schemaVersion` (e.g. 99) or pointing to a different Git repository are rejected cleanly before any worktree or bisection mutation occurs.
- **Recovery CLI Documentation (P1.6):** Documented `needs_recovery` meaning, session inspection, resume commands, and blocked-recovery conditions in CLI `HELP_TEXT`, `README.md`, `docs/architecture.md`, and `docs/safety-model.md`.
- **Multi-Machine mTLS Runbook (P1.2):** Created `docs/multimachine-mtls-setup.md` detailing dedicated PKI generation, daemon and remote worker deployment, fencing tokens, and network-partition lease expiration tests. Loopback suite passes 10/10 tests; real physical multi-machine execution is documented as `BLOCKED` / `UNVERIFIED` due to single-host test environment.
- **Verification Suite Totals:**
  - `npm test`: 229 tests (228 passed, 1 skipped on macOS for missing local container runtime, 0 failed across 29 suites).
  - `npm run test:py`: 4/4 passed.
  - `package-distribution`: 3/3 passed.
  - `npm --prefix website run test`: 8/8 static pages generated cleanly.
  - `git diff --check`: 0 formatting or whitespace errors.

## Outstanding Verification Gaps & Remediation

1. **Native Windows checkout:** The current tracked-path audit found zero paths
   ending in spaces, and the recorded Windows CI matrix run completed. Keep the
   path audit in release verification because a future generated or restored
   tree entry could reintroduce the NTFS failure.
2. **Real rootless container execution:** The macOS development host has no
   usable rootless Docker/Podman runtime, so the real sandbox integration test
   remains skipped locally. The CI workflow attempts the Podman test when the
   runner exposes a rootless runtime; if it does not, the step currently reports
   the limitation rather than failing the whole matrix.
3. **Physical multi-machine mTLS:** This still requires two distinct networked
   hosts. Run the automated protocol and partition checks from
   `docs/multimachine-mtls-setup.md` across two authorized machines before
   claiming production multi-host coverage.

## P2 — Deferred Post-Release Items
- P2.1: Optional OpenTelemetry Collector OTLP exporter bridge.
- P2.2: Website Explorer workspace-scope display indicator.
- P2.3: Deeper native Windows process-tree (`taskkill.exe`) and daemon restart verification.
- P2.4: Open-source community files (CHANGELOG, CONTRIBUTING, issue templates, npm provenance).
