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
    - **Opt-In Rootless Sandbox**: Digest-pinned local Docker/Podman execution with structured rootless verification, no network, read-only root filesystem, dropped capabilities, resource limits, approved mounts, bounded output, and owned-container cleanup (`Step 10`).
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

# Plan bisection range and estimate steps (supports monorepos with --cwd and --scope)
bisectpilot plan --config <config.json> [--cwd <path>] [--scope <paths>] [--good <ref>] [--bad <ref>] [--terms <old,new>]

# Start automated bisection (direct execution by default)
bisectpilot start --config <config.json> [--cwd <path>] [--scope <paths>] [--yes] [--good <ref>] [--bad <ref>] [--terms <old,new>] [--noisy] [--prompt] [--sandbox <docker|podman>] [--sandbox-image <repo@sha256:...>]

# Inspect session status, resume after crash, or generate handoff report
bisectpilot status <sessionId>
bisectpilot resume <sessionId>
bisectpilot report <sessionId> [--json] [--html] [--github-summary [file]] [--github-issue] [--out <file>] [--verify]
bisectpilot cleanup <sessionId> [--dry-run]
bisectpilot list

# Start a local daemon, queue a consented campaign, and run a pull worker
bisectpilot daemon start [--state-dir <dir>] [--host <host>] [--port <port>] [--tls-cert <crt>] [--tls-key <key>] [--tls-ca <ca>] [--tls-require-client-cert] [--tls-allowed-identity <cn>]
bisectpilot daemon status [--state-dir <dir>]
bisectpilot daemon stop [--state-dir <dir>]
bisectpilot daemon revoke --state-dir <dir> [--fingerprint <sha256>] [--worker-id <id>] [--reason <msg>]
bisectpilot daemon enqueue --config <config.json> --yes [--repository-key <key>] [--state-dir <dir>]
bisectpilot daemon cancel <jobId> [--state-dir <dir>]
bisectpilot daemon recover <jobId> [--state-dir <dir>]
bisectpilot worker start --server <http(s)://host:port> --token-file <path> --repo <key=absolute-path> [--tls-cert <crt>] [--tls-key <key>] [--tls-ca <ca>] [--tls-servername <host>] [--worker-id <id>]
bisectpilot worker status [--state-dir <dir>]
bisectpilot worker stop [--state-dir <dir>]

# Queue from the existing start path instead of running in the initiating terminal
bisectpilot start --config <config.json> --yes --background [--daemon-state-dir <dir>] [--repository-key <key>]

# Monorepo & Multi-Package investigation
bisectpilot plan --config config.json --cwd packages/api
bisectpilot start --config config.json --cwd packages/api --yes

# Performance regression & benchmark bisection
bisectpilot plan --metric latency_ms --threshold 150 --relative-regression 15% --direction higher_is_worse
bisectpilot start --metric latency_ms --threshold 150 --relative-regression 15% --warmup 1 --samples 5

# Minimize failure-inducing test input using Delta Debugging (ddmin)
bisectpilot minimize <inputPath> --test <cmd> [--args <args>] [--out <path>] [--budget <n>] [--timeout <ms>] [--granularity <line|char|both>] [--noisy] [--json]
```

Daemon and worker state live under `.bisectpilot/daemon` and `.bisectpilot/worker` by default. The daemon uses a protected generated token file, loopback HTTP and atomic queue state. Non-loopback daemon binds require `--tls-cert`, `--tls-key`, and client CA configuration; workers reject plaintext remote URLs. Mutual TLS (mTLS) enforces bidirectional certificate verification, client Subject CN matching, SHA-256 fingerprint allowlisting/revocation, and POSIX 0o600 key permissions. Async jobs use explicit `goodRef` values, headless execution, pre-provisioned repository mappings and no persisted `execution.envOverrides`.

### Rootless container sandbox

Sandboxing is opt-in; omitting `execution.sandbox` preserves the existing direct `spawn()` path. To enable it, select a locally available, lowercase digest-pinned image and either configure the policy or use the CLI flags:

```bash
bisectpilot plan --config bisectpilot.config.json --sandbox podman --sandbox-image ghcr.io/acme/test-runner@sha256:<64-lowercase-hex>
bisectpilot start --config bisectpilot.config.json --yes --sandbox podman --sandbox-image ghcr.io/acme/test-runner@sha256:<64-lowercase-hex>
```

The runtime must be Docker or Podman on the local host and must report effective rootless operation. BisectPilot never pulls images, falls back to host execution, or accepts runtime sockets, writable extra mounts, non-repository paths, persisted sandbox environment overrides, or network access. Historical commands run with `--network none`, a read-only container root, `CAP_DROP=ALL`, `no-new-privileges`, non-root numeric uid/gid, bounded CPU/memory/PID/tmpfs resources, and only the worktree plus approved read-only session inputs mounted. Containers receive BisectPilot ownership labels; cleanup stops and removes only a container whose ownership and restrictions can be verified. Runtime/image/policy/cleanup failures abort closed and are not regression evidence.

For async jobs, workers discover and advertise only runtimes that pass the same local rootless probe. Sandbox jobs are rejected when the required runtime or enforced `LocalBisectEngine` boundary is unavailable. A real-runtime integration test runs only when `BISECTPILOT_SANDBOX_IMAGE` names a local digest-pinned image; otherwise it is explicitly skipped and reports why.

## Performance Regression & Benchmark Bisection

BisectPilot detects performance regressions using repeatable benchmark measurements instead of binary pass/fail exit codes:

- **Metric Formats**: Extracts metrics from structured JSON (flat or nested), key-value text (`metric: 123.4 ms`), and regex patterns. Rejects non-finite values (`NaN`, `Infinity`), missing metrics, and incompatible units.
- **Direction Awareness**: Supports metrics where higher is worse (`latency_ms`, `memory_mb`, `duration`) and lower is worse (`throughput_ops_sec`, `requests_per_sec`).
- **Statistical Rigor**: Computes sample statistics (mean, variance, stdDev, min, max, p50/median, p95, p99) and runs Welch's two-sample t-test ($t = \frac{\bar{X}_2 - \bar{X}_1}{\sqrt{s_1^2/n_1 + s_2^2/n_2}}$) with Welch-Satterthwaite degrees of freedom and Student's t two-tailed p-values via the regularized incomplete beta function ($I_x(a, b)$).
- **Practical & Statistical Significance**: Revisions are classified as regressions only when they breach practical thresholds (absolute threshold and/or relative percentage) *and* reach statistical significance ($p < \alpha$, default $\alpha = 0.05$). Noisy and ambiguous measurements are classified as `inconclusive`.
- **Warmup & Sequential Stopping**: Warm-up runs are excluded from sample statistics. Sequential sampling stops early when statistical confidence is achieved after minimum sample requirements.
- **Preflight & Boundary Verification**: Verifies baseline performance at good endpoint, confirms regression exists at bad endpoint prior to bisection, and verifies candidate culprit and its parent.

## Monorepo & Multi-Package Bisection

BisectPilot supports package-specific regression investigations within monorepos (npm/pnpm/yarn/bun workspaces, Lerna, Turborepo, Nx, Cargo):

- **Path Safety**: `--cwd <path>` resolves safely relative to the Git repository root with strict validation preventing directory traversal (`../`) and symlink-based escapes.
- **Path-Scoped History**: Native `git bisect start <bad> <good> -- <paths...>` argument passing. Automatically scopes revision traversal to the target package directory *plus* root-level dependency manifests and lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `tsconfig.json`) so shared root regressions are never missed.
- **Untestable Historical Revisions**: Historical commits checked out before the package directory existed are cleanly skipped with reason code `untestable_revision` rather than crashing.
- **Dependency & Lockfile Hashes**: Cryptographic SHA-256 hashes of root lockfiles, root manifests, and package manifests are recorded in the evidence ledger at every evaluated revision.
- **Isolated Reproduction Script**: Generated `repro.sh` switches into `cd "$TMP_WT/${workDirRel}"` to accurately reproduce results.

## Reporting & CI Integration

BisectPilot generates rich, portable evidence artifacts for both local developer workflows and automated CI pipelines:

1. **Standalone Offline HTML Reports (`--html`)**:
   Generates a self-contained, responsive `report.html` that can be opened directly in any browser without a web server or network connection (zero CDNs, zero remote fonts). Includes live filtering, instant revision search, interactive timeline, noisy-sampling posterior metrics, boundary verification checks, cryptographic hash-chain audit viewer, and one-click SHA copying.
   ```bash
   bisectpilot report <sessionId> --html --out report.html
   ```

2. **GitHub Actions Step Summary (`--github-summary` / `$GITHUB_STEP_SUMMARY`)**:
   When running inside GitHub Actions, bisection results are automatically formatted into GitHub-flavored Markdown and appended to `$GITHUB_STEP_SUMMARY`. You can also trigger or target it explicitly:
   ```bash
   bisectpilot report <sessionId> --github-summary
   # Or specify an explicit output path:
   bisectpilot report <sessionId> --github-summary ./summary.md
   ```

3. **GitHub Issue & Pull-Request Export (`--github-issue`)**:
   Generates copy-paste-ready Markdown formatted specifically for opening a GitHub Issue or attaching to a Pull Request:
   ```bash
   bisectpilot report <sessionId> --github-issue --out issue.md
   ```

## Distribution & Packaging

BisectPilot is packaged as a lightweight, zero-runtime-dependency npm module with a dedicated CLI executable and complete TypeScript declarations:

```bash
# Verify package contents
npm pack --dry-run

# Build distributable tarball
npm pack
```

## Scripts

- `npm run build` — Compile TypeScript (`src/`, `tests/`) to `dist/`
- `npm run prepack` — Pre-distribution compile hook
- `npm run typecheck` — Strict TypeScript check (`tsc --noEmit`)
- `npm test` — Run all TypeScript unit, integration, and safety tests
- `npm run test:py` — Run Python trace diff unit tests
- `npm --prefix website run test` — Run website typecheck, linting, and build

## Session Recovery

Each session keeps a hash-chained `events.jsonl` ledger plus `checkpoint.json` / `checkpoint.backup.json`. After a crash run `bisectpilot status <sessionId>` (shows checkpoint seq, classified count, resumable) then `bisectpilot resume <sessionId>`. Revisions already classified are reused, not re-run. If the checkpoint is corrupt it is rebuilt from the ledger; if the ledger itself is tampered with, resume stops with an error. Durability covers process crashes, not power loss.

## Status & Roadmap

Implemented: native Git Bisect engine, noisy-oracle sampling, performance mode (Welch + Mann-Whitney), workspaces, reports (JSON/MD/HTML/GitHub), daemon + durable queue, mTLS workers, rootless sandbox, distributed sampling, Prometheus/tracing, session recovery.

Still to do: verification on real Linux/Windows CI and multi-machine TLS, fsync-level durability and process-kill crash tests, optional OTLP exporter, website workspace-scope display, CHANGELOG/CONTRIBUTING, npm provenance setup. See `docs/handoff.md`.
