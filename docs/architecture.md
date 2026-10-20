# BisectPilot Microlithic Architecture

## 1. Architectural Overview

BisectPilot uses a **local-first microlithic architecture** (modular monolith) with strict boundaries between domain rules, infrastructure adapters, and application orchestration:

```text
BisectPilot/
├── src/
│   ├── contracts/      # Frozen shared types, schema validators, CustomBisectTerms, NoisyOraclePolicy & FakeEngine
│   ├── config/         # Config loading, hashing, validation & deterministic env defaults
│   ├── domain/         # Classification rules, Bayesian math (closed-form posterior), Delta Debugging (ddmin) & Workspace safety/dependency scoping
│   ├── git/            # Git >= 2.36 inspection, ref resolution, ancestry & doctor checks
│   ├── worktree/       # Detached session worktree creation & guarded ownership verification
│   ├── process/        # Safe child_process execution plus opt-in rootless Docker/Podman boundary
│   ├── oracle/         # in-tree, overlay, prompt, toolchain & workspace-aware oracle execution with multi-sample noisy mode
│   ├── ledger/         # Append-only hash-chained JSONL evidence ledger & chain verification
│   ├── session/        # Atomic manifest persistence, transitionSessionState() & lockfiles
│   ├── runner/         # External stable runner invoked by native `git bisect run`
│   ├── reports/        # Redaction, JSON/Markdown/HTML reports, GitHub Actions summaries, replay-adapter & standalone repro.sh
│   ├── application/    # LocalBisectEngine orchestrating discovery, preflight, bisect, recovery & minimization
│   ├── cli/            # Command-line dispatch (doctor, plan, start/run, status, report, cleanup, list, minimize)
│   ├── jobs/           # Atomic durable queue, typed transitions, leases & idempotent results
│   ├── daemon/         # Loopback-by-default authenticated HTTP daemon & lifecycle CLI
│   ├── worker/         # Pull worker, repository validation & heartbeats
│   └── bisectpilot/    # Preserved zero-dependency Python JSONL trace diff helper
├── tests/
│   ├── unit/           # Unit tests (contracts, cli, custom-terms, noisy-oracle, minimizer, repro-script, prompt, wrapper, workspace, html-report, github-summary)
│   ├── integration/    # Real temp-Git & packaging integration tests (auto-good-discovery, engine-bisect, package-distribution, monorepo-bisect)
│   ├── fixtures/       # Reusable deterministic Git repository fixture builder & FakeEngine
│   ├── safety/         # Overlay conflict, toolchain mismatch, tracked mutation & cancellation tests
│   └── test_bisectpilot.py # Preserved Python CLI unit test suite
└── website/            # Next.js 16 interactive replay specimen (/explorer)

```

## 2. Dependency Direction

- `contracts/` and `domain/` have **zero** dependencies on filesystem, Git, or child processes (with domain workspace utilities depending only on Node's `path` and `crypto`).
- `git/`, `worktree/`, `process/`, and `ledger/` depend only on Node.js stdlib and `contracts/`.
- `session/` and `oracle/` compose those low-level modules.
- `application/` (`LocalBisectEngine`) coordinates the end-to-end investigation workflow and implements `BisectEngine`.
- Tests verify contracts against temporary Git repositories, isolated sub-processes, and simulated environments.

## 3. Daemon & Pull Worker Architecture (Step 9)

- `src/jobs/` stores one atomic JSON snapshot under the daemon state directory. A single transition function rejects illegal job states. Delivery is at-least-once; attempt identities and duplicate-result handling prevent stale workers from overwriting newer results.
- `src/daemon/` owns scheduling, leases, worker registration, cancellation, recovery and lifecycle state. It binds to loopback by default; non-loopback binds require HTTPS certificate and key files.
- `src/worker/` polls outbound, validates a pre-provisioned repository mapping and target SHAs, then calls the existing `LocalBisectEngine`. It never classifies revisions independently.
- Queue recovery retries work that lost its lease before first heartbeat. Work that started or became ambiguous enters `needs_recovery` and requires explicit `daemon recover <jobId>` before another attempt.
- Native Git Bisect remains serialized inside each session. Different jobs can run on separate workers only when their repository mappings and resource limits are independent.

## 4. Rootless Sandbox Architecture (Step 10)

- `src/adapters/process/sandbox-runtime.ts` is the only Docker/Podman boundary. It uses an injected executor for deterministic tests and the real CLI only after local endpoint, version, structured rootless, and local-image probes pass.
- `runSafeProcess()` preserves the direct shell-free process path unless `execution.sandbox` is present. Sandbox execution rejects non-root POSIX hosts, non-digest-pinned images, remote runtime endpoints, network policies other than `none`, unsafe resources, arbitrary mounts, and paths outside the worktree or explicitly approved read-only roots.
- Containers are created with a read-only root filesystem, no network, dropped capabilities, `no-new-privileges`, numeric non-root uid/gid, bounded CPU/memory/PID/tmpfs resources, a cleared image entrypoint, and a writable worktree mount plus narrowly scoped read-only inputs. The created container is inspected before start to attest ownership and restrictions.
- Container IDs and owner labels are recorded in the hash-chained ledger immediately after creation through `sandbox_created`; cleanup stops/kills/removes only an ownership-matching container. A failed ownership check is never followed by broad cleanup.
- Runtime output remains bounded while hashes and observed byte counts cover the full retained runtime stream. Timeout and cancellation take precedence over ordinary sandbox failure codes; cleanup failure always aborts closed.
- `LocalBisectEngine` carries the injected runtime executor through every prepare/build/oracle/boundary step. Workers discover runtimes before registration and only the enforced `LocalBisectEngine` is accepted for sandbox jobs.

## 5. Monorepo & Multi-Package Architecture (Step 7)

- **Path Safety**: `validateWorkspacePath` strictly checks against path traversal (`..`), absolute path escapes, and symlinks resolving outside the repository root.
- **Path-Limited Native Bisection**: Rather than custom history filtering, BisectPilot passes the path scope array (`-- <paths...>`) directly into `git bisect start`.
- **Automatic Shared Dependency Scope**: The default path scope includes both the package directory and root manifests/lockfiles (`package.json`, `pnpm-workspace.yaml`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `lerna.json`, `turbo.json`, `nx.json`, `.nvmrc`, `.node-version`, `tsconfig.json`).
- **Untestable Pre-Creation Commits**: If a checked-out commit predates the workspace directory's existence, the oracle flags it as `skip` with reason `untestable_revision` instead of failing unexpectedly.
- **Dependency Hash Ledger**: Manifest and lockfile SHA-256 hashes are captured at each revision and recorded in `RevisionClassifiedEvent.toolchainInfo` for forensic auditability across monorepo commits.

## 6. Performance Regression & Benchmark Bisection Architecture (Step 8)

- **Pure Statistical Domain (`src/domain/statistics.ts`)**: Zero-dependency statistical methods for sample mean, sample variance, standard deviation, percentiles (p50/median, p95, p99), Lanczos approximation of $\ln\Gamma(z)$, regularized incomplete beta function $I_x(a, b)$ via modified Lentz's continued fraction method, Student's t distribution two-tailed p-values, and Welch's two-sample t-test ($t = \frac{\bar{X}_2 - \bar{X}_1}{\sqrt{s_1^2/n_1 + s_2^2/n_2}}$) with Welch-Satterthwaite degrees of freedom.
- **Benchmark Collection & Metric Extraction (`src/domain/benchmark.ts`)**: Robust metric parsing from flat/nested JSON, key-value text, and regex patterns. Strictly rejects non-finite values (`NaN`, `Infinity`, `null`), missing metrics, and mismatched measurement units.
- **Warmup Exclusion & Sequential Stopping**: Warm-up sample measurements are excluded from the statistical sample set. Once `minSamples` is reached, sequential early stopping evaluates statistical significance ($p < \alpha$) to terminate sampling early when clear regression or non-regression is demonstrated.
- **Practical & Statistical Significance**: Revisions are classified as regressions only when they breach practical thresholds (absolute threshold and/or relative percentage) *and* reach statistical significance. Normal measurement variance without significant effect size is classified as non-regression, while high-variance ambiguous data is marked `inconclusive`.
- **Git Bisect Preflight & Boundary Integrity**: Good endpoint preflight establishes `benchmarkBaseline` recorded in `SessionManifestV1`. Bad endpoint preflight verifies that the regression is present before launching bisection. Boundary checks re-evaluate candidate culprit and its parent against baseline.
- **Tamper-Evident Ledger**: Full statistical telemetry is persisted into the append-only hash-chained JSONL ledger on each `revision_classified` event and exported to JSON, Markdown, HTML, and GitHub Actions step summaries.

## 7. Mutual TLS & Remote Worker Security Architecture (Step 11)

- **Bidirectional Certificate Verification**: Both endpoints authenticate each other using Node standard library `node:https` and `node:tls`. Worker verifies daemon certificate chain and hostname (`rejectUnauthorized: true`). Daemon requires and verifies client certificates (`requestCert: true`, `rejectUnauthorized: true`). Certificate verification is never bypassed.
- **Strict Transport Boundaries**: Non-loopback daemon binds reject plain HTTP startup and require valid server certificates, private keys, and trusted client CA certificates. Remote pull workers reject non-loopback HTTP endpoints. Private keys are verified to have strict POSIX permissions (`0o600`).
- **Worker Identity & Capability Mapping**: Daemon extracts peer certificate Subject Common Name (`CN`) and SHA-256 fingerprint from the TLS handshake. The claimed `workerId` must match the Subject CN; mismatching identities are rejected. Optional allowed identities and allowed fingerprints configure authorization allowlists.
- **Immediate Fingerprint Revocation**: In-flight certificate checks compare the peer certificate's SHA-256 fingerprint against revoked fingerprints on every request over established TLS connections, cutting off revoked workers immediately without waiting for TCP connection resets.
- **Zero-Downtime Context Rotation**: Daemon supports dynamic TLS context rotation via `daemon.rotateServerTls()` calling `server.setSecureContext()` after pre-validating candidate certificate and key files with `tls.createSecureContext()`. Client supports dynamic credential rotation via `client.rotateTlsCredentials()`.
- **Administrative Revocation Interface**: Administrative actions are exposed via `/v1/admin/revoke` (loopback-only or bearer-authenticated) and `bisectpilot daemon revoke` CLI subcommand, persisting revoked fingerprints and worker IDs to `revocations.json`.
- **Linux Rootless Podman CI**: Integration tests in `.github/workflows/ci.yml` verify effective rootless Podman execution (`host.security.rootless == true`) on Linux runners with a digest-pinned image, establishing real runtime isolation verification.
