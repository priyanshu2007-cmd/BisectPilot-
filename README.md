# BisectPilot

[![CI](https://github.com/priyanshu2007-cmd/BisectPilot-/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/priyanshu2007-cmd/BisectPilot-/actions/workflows/ci.yml)

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

## How to Use the Project

BisectPilot has three related surfaces. Choose the one that matches the job you
are doing:

| Surface | Use it for | Start here |
| --- | --- | --- |
| TypeScript engine and CLI | Finding the first Git revision that changes a test or benchmark result | `npm run build`, then `node dist/src/index.js --help` |
| Python trace-diff utility | Comparing JSONL AI traces and exporting a replayable web scenario | `npm run test:py`, then `python -m bisectpilot --help` with `PYTHONPATH=src` |
| Next.js website | Exploring deterministic sample runs or importing a CLI JSON report | `npm --prefix website run dev`, then <http://localhost:3000> |

### 1. Prepare the repository

Use the pinned Node version when possible, then install the root dependencies:

```bash
nvm install
nvm use
npm ci
npm run build
```

The project does not require a database, cloud account, API key, or external
service for local regression bisection. The optional `.env.example` contains
only deterministic local defaults. Never put credentials in a config file,
session directory, report, or Git commit.

### 2. Run the CLI against a Git repository

Start with diagnostics and a starter configuration. `init` writes a JSON file;
edit the command and Git references for the repository you want to investigate.
The starter uses `HEAD~5` as the good reference and `HEAD` as the bad reference,
with `npm test` as the in-tree oracle.

```bash
node dist/src/index.js doctor .
node dist/src/index.js init --out bisectpilot.config.json
# Edit bisectpilot.config.json, then inspect the plan:
node dist/src/index.js plan --config bisectpilot.config.json
```

For a normal run, explicitly consent to executing historical repository code:

```bash
node dist/src/index.js start \
  --config bisectpilot.config.json \
  --yes
```

The engine runs in a tool-owned detached worktree, not in the primary checkout.
After the run, use the session ID printed by the CLI:

```bash
node dist/src/index.js status <sessionId>
node dist/src/index.js report <sessionId> --json --out report.json --verify
node dist/src/index.js report <sessionId> --html --out report.html
node dist/src/index.js report <sessionId> --github-summary summary.md
node dist/src/index.js cleanup <sessionId> --dry-run
node dist/src/index.js cleanup <sessionId>
```

`status` is the safe first command after an interruption. If it reports
`needs_recovery`, inspect the checkpoint and then explicitly resume:

```bash
node dist/src/index.js status <sessionId>
node dist/src/index.js resume <sessionId>
```

Resume is fail-closed when the lock is still held by a live process, the
repository or worktree identity changed, ownership markers are missing, the
ledger hash chain is broken, or the checkpoint schema is unsupported.

### 3. Use the advanced CLI modes

- **Automatic good endpoint:** use `--good auto` when the good boundary is not
  known and the repository history contains a usable ancestor or tag.
- **Monorepo scope:** use `--cwd packages/api` and optionally `--scope src
  tests` to limit history safely while still including root manifests and
  lockfiles.
- **Noisy tests:** add `--noisy` when repeated executions can disagree. The
  Bayesian sampler records its evidence and stops when the configured confidence
  boundary is reached.
- **Performance regressions:** use `--metric`, `--threshold`,
  `--relative-regression`, `--direction`, and sampling flags. The engine records
  warmups, sample statistics, Welch's t-test, and boundary checks.
- **Input minimization:** use `minimize <inputPath> --test <command>` to reduce
  a failure-inducing file with a bounded line/character budget.
- **Sandboxing:** pass `--sandbox docker|podman` and a local lowercase
  digest-pinned `--sandbox-image`. Sandboxing is opt-in; it never pulls an
  image, enables networking, or falls back to unsandboxed execution.

### 4. Use the daemon and worker workflow

The daemon is a local authenticated queue. The worker polls outbound and must
use a pre-provisioned repository mapping. Keep the default loopback HTTP mode
for one-machine development; use the mTLS runbook for remote workers.

```bash
node dist/src/index.js daemon start --state-dir .bisectpilot/daemon
node dist/src/index.js daemon status --state-dir .bisectpilot/daemon
node dist/src/index.js daemon enqueue \
  --config bisectpilot.config.json \
  --yes \
  --state-dir .bisectpilot/daemon
node dist/src/index.js daemon recover <jobId> --state-dir .bisectpilot/daemon
node dist/src/index.js daemon stop --state-dir .bisectpilot/daemon
```

For distributed execution, configure HTTPS, a trusted client CA, worker
certificates, Subject CN identity matching, and fingerprint revocation. Follow
[`docs/multimachine-mtls-setup.md`](docs/multimachine-mtls-setup.md) rather than
inventing certificate or repository-sharing steps.

## Testing and Verification

Run checks in this order when changing the engine:

```bash
npm run typecheck
npm test
npm run test:py
npm pack --dry-run
git diff --check
```

Useful narrower commands are:

```bash
npm run test:unit
npm run test:integration
npm run test:safety
node --test dist/tests/integration/fresh-clone-e2e.test.js
node --test dist/tests/integration/session-resume-recovery.test.js
```

The website has its own lockfile and command set:

```bash
npm --prefix website ci
npm --prefix website run typecheck
npm --prefix website run lint
npm --prefix website run build
npm --prefix website run test
```

The website test is a composite check: TypeScript validation, ESLint, and a
production Next.js build. A browser interaction smoke test is useful after UI
changes, but it is separate from the static build check.

## Security Checks

These checks are safe to run locally and do not send source code to an external
service:

```bash
npm audit --offline
npm audit --omit=dev --offline
gitleaks git --redact --no-banner --config .gitleaks.toml
uv lock --check
```

If available in your environment, also run `pip-audit` and `osv-scanner`. The
repository's CI workflows run CodeQL, Gitleaks, Dependabot configuration checks,
package-content validation, and an SPDX SBOM generation step. Security review
must preserve the project boundaries: historical repository code is untrusted,
the default worktree is not an OS sandbox, and remote daemon binds require mTLS.

## Debugging a Failed Run

1. Reproduce the failure with the smallest command: `doctor`, `plan`, one
   targeted test file, or one session report.
2. Check `status <sessionId>` before touching a session directory. Record the
   reported lifecycle state, checkpoint sequence, WAL sequence, and resumability.
3. Inspect the generated JSON report with `--verify`; do not treat an HTML view
   as the authoritative ledger.
4. If a process died, use `resume` only after confirming no live process owns
   the session lock. Use `cleanup --dry-run` before cleanup.
5. For daemon work, compare `daemon status`, job state, lease ownership, worker
   identity, and `/metrics` output. Never delete queue or session files to make a
   test green.
6. For sandbox failures, verify runtime availability, rootless mode, local image
   digest, resource limits, and the explicit no-network policy. A skipped real
   runtime test means isolation was not verified on that host.

When reporting a bug, include the exact command, platform, Node/Python versions,
session state, redacted report or error, and the smallest reproducible fixture.
Do not include tokens, private keys, full environment dumps, or unredacted
historical repository data.

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

BisectPilot is packaged as a lightweight, zero-runtime-dependency npm module (`@priyanshu2007-cmd/bisectpilot`) with a dedicated CLI executable and complete TypeScript declarations.

### Installation via GitHub Packages

Configure `.npmrc`:
```ini
@priyanshu2007-cmd:registry=https://npm.pkg.github.com
```

Install:
```bash
npm install @priyanshu2007-cmd/bisectpilot
# Or execute directly via npx
npx @priyanshu2007-cmd/bisectpilot --help
```

### Local Packaging Verification

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

Each session maintains an append-only, SHA-256 hash-chained `ledger.jsonl` (WAL) alongside atomic `checkpoint.json` and `checkpoint.backup.json` snapshots.
- **Durable Writes**: Checkpoints are written to process temporary files, flushed to storage with `fsyncSync`, atomically replaced, and the containing directory descriptor is synchronized on POSIX systems.
- **Process Crash vs. OS Crash**: Process crashes (SIGKILL) are 100% crash-consistent and resume safely. OS crash and power-loss protection is best-effort via temporary-file and directory `fsync`; if hardware write caching ignores flush, recovery falls back to `checkpoint.backup.json` or reconstructs the state from `ledger.jsonl`.
- **Resume Workflow**: After an unexpected exit, inspect the session with `bisectpilot status <sessionId>` to view checkpoint sequence, classified commit count, and whether recovery is safe. Run `bisectpilot resume <sessionId>` to restart native `git bisect run`. Revisions already classified in the checkpoint cache are reused instantly without re-running tests or sandboxes.
- **Blocked Recovery**: Resumption is blocked with a clear error if an active PID holds the session lock, if the checkpoint refers to a different repository, if worktree ownership markers are missing, if the WAL hash chain is broken, or if the checkpoint uses an unsupported schema version. All user checkouts and ledger artifacts are strictly preserved.

## Status & Roadmap

Implemented & Locally Verified:
- Native Git Bisect engine, `--good auto` discovery, noisy-oracle Bayesian SPRT sampling.
- Monorepo workspace scoping (`--cwd`, `--scope`), dependency hashing, and monorepo preflight.
- Performance bisection mode with Welch's t-test and Mann-Whitney U test.
- Reports: JSON, Markdown, standalone interactive offline HTML, and GitHub Actions step summaries.
- Local daemon and pull-worker fleet coordination, lease fencing, and heartbeats.
- Mutual TLS (mTLS) with Subject CN verification, dynamic context rotation, and certificate revocation.
- Digest-pinned rootless container sandbox with Docker/Podman runtime discovery.
- Observability: W3C Trace Context propagation, Prometheus `/metrics`, and Grafana dashboard templates.
- Durable checkpointing (`fsyncSync`), tri-level recovery fallback, and SIGKILL process-kill integration tests.
- Standalone multi-machine mTLS deployment runbook (`docs/multimachine-mtls-setup.md`).

Outstanding Release Blockers:
- Native Windows CI: Blocked by Git tree entry with trailing space (`skills `) causing NTFS checkout failures (`Invalid argument`).
- Linux Rootless Podman CI: Standard GitHub Actions hosted runner requires pre-configured rootless subuid/subgid mapping for container isolation tests.
- Physical Multi-Machine mTLS: Automated on loopback (10/10 tests pass); physical deployment across separate hardware nodes remains unverified.

P2 Deferred Post-Release Items:
- Optional OpenTelemetry Collector OTLP exporter bridge.
- Website Explorer workspace-scope display indicator.
- Deeper native Windows process-tree (`taskkill.exe`) and daemon restart tests.
- Open-source community files (CHANGELOG, CONTRIBUTING, issue templates, npm provenance).
