# BisectPilot

[![CI](https://github.com/priyanshu2007-cmd/BisectPilot-/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/priyanshu2007-cmd/BisectPilot-/actions/workflows/ci.yml)

> BisectPilot automates native Git Bisect to help identify the commit that introduced a regression.
>
> It verifies known-good and known-bad endpoints, runs checks in dedicated worktrees, and records revision classifications and command evidence in a tamper-evident ledger.
>
> It supports configurable oracles, flaky-test sampling, performance-regression analysis, monorepo path scoping, and checkpoint-based session recovery.
>
> Investigation results can be exported as JSON, Markdown, or a self-contained offline HTML report for debugging and CI handoff.
>
> Optional daemon/worker coordination, mutual TLS, and a rootless Docker/Podman sandbox support more controlled workflows when correctly configured.

Built for software engineers, QA engineers, and CI/CD maintainers who need reproducible, evidence-backed regression bisection without mutating their working checkout.

## Contents

- [What BisectPilot Does](#what-bisectpilot-does)
- [Key Features](#key-features)
- [Requirements and Compatibility](#requirements-and-compatibility)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Practical CLI Reference](#practical-cli-reference)
- [Configuration and Oracle Guide](#configuration-and-oracle-guide)
- [Monorepo and Performance Workflows](#monorepo-and-performance-workflows)
- [Safety Model](#safety-model)
- [Session Recovery and Evidence Reports](#session-recovery-and-evidence-reports)
- [Daemon and Remote Worker Setup](#daemon-and-remote-worker-setup)
- [Python Helper and Website](#python-helper-and-website)
- [Development and Testing](#development-and-testing)
- [Known Limitations and Current Status](#known-limitations-and-current-status)
- [License and Helpful Links](#license-and-helpful-links)

---

## What BisectPilot Does

When a test starts failing or a benchmark regresses in a newer revision, finding the exact commit responsible across dozens or hundreds of commits is tedious and error-prone. Running `git bisect` directly in a development checkout can disturb uncommitted work, misclassify build failures or timeouts as test regressions, and leave behind no structured audit trail when a run is interrupted.

BisectPilot wraps native `git bisect` in a structured, evidence-first workflow:

1. **Validate endpoints first:** Verify that the known-good revision passes and the known-bad revision fails before starting the binary search (or automatically discover a passing ancestor with `--good auto`).
2. **Drive search via native Git Bisect:** Delegate commit graph traversal to `git bisect start` and `git bisect run`, supporting standard `good`/`bad` or custom `--terms`.
3. **Isolate checkouts in a dedicated worktree:** Evaluate every candidate revision inside a tool-owned detached worktree (`.bisectpilot/sessions/<sessionId>/worktree`) so your primary checkout is never modified or reset.
4. **Record tamper-evident evidence:** Log every command execution, exit code, output digest, toolchain check, and classification into a SHA-256 hash-chained JSONL ledger (`ledger.jsonl`).
5. **Verify boundaries and export reports:** Confirm the culprit commit against its parent and generate portable JSON, Markdown, standalone offline HTML, GitHub Actions step summaries, and an executable `repro.sh` script.
6. **Inspect and resume interrupted sessions:** Persist checksummed checkpoints (`checkpoint.json` and `checkpoint.backup.json`) so interrupted runs can be inspected with `status` and resumed with `resume` without re-running already classified commits.

---

## Key Features

- **Reliable Git regression bisection:** Native `git bisect` orchestration, preflight endpoint validation (`endpointFlakeRuns`), candidate-and-parent boundary confirmation (`boundaryConfirmRuns`), custom bisect terms (`--terms <old,new>`), and automatic good-endpoint discovery (`--good auto`) across tags and exponential commit distances.
- **Oracle execution:** Three execution modes (`in-tree`, `overlay` with SHA-256 snapshotting and conflict policies, and `external` scripts), plus human-in-the-loop interactive classification (`--prompt`), toolchain wrappers (`toolchainWrapper`), and Bayesian sequential sampling for flaky/noisy tests (`--noisy`).
- **Safe execution:** Detached session worktrees, mandatory 5-point ownership verification before any reset or cleanup, shell-free child process spawning (`shell: false`), deterministic environment defaults (`CI=1`, `TZ=UTC`, `LANG=C.UTF-8`, `NO_COLOR=1`), and an opt-in rootless Docker/Podman sandbox (disabled by default; local execution is used unless `--sandbox` or `execution.sandbox` is configured).
- **Performance analysis:** Structured metric extraction (JSON, key-value, regex), warmup run exclusion, repeated sampling, Welch's two-sample t-test and Mann-Whitney U rank-sum statistics, direction-aware comparisons (`higher_is_worse` / `lower_is_worse`), and combined practical + statistical significance thresholds.
- **Monorepos:** Package-scoped execution (`--cwd`), path traversal and symlink escape protection, automatic inclusion of root lockfiles and workspace manifests in `git bisect` path scopes, and clean skipping (`untestable_revision`) for commits that predate a package directory.
- **Evidence and reports:** Append-only SHA-256 hash-chained `ledger.jsonl` with token/key redaction, structured `report.json`, `report.md`, zero-dependency standalone `report.html`, GitHub Actions step summaries (`--github-summary`), GitHub issue/PR exports (`--github-issue`), standalone `repro.sh`, and Delta Debugging (`ddmin`) test-input minimization (`bisectpilot minimize`).
- **Recovery:** Atomic checksummed checkpoints (`checkpoint.json`, `checkpoint.backup.json`) with POSIX `fsyncSync` durability, tri-level fallback (`primary` -> `backup` -> `ledger.jsonl` replay), stale-lock detection (`needs_recovery`), cached classification fast-forwarding, and fail-closed repository/schema/ledger validation.
- **Distributed execution:** Optional local-first HTTP/HTTPS daemon and outbound-polling worker service (`bisectpilot daemon` / `bisectpilot worker`), lease fencing tokens, capability matching, Prometheus `/metrics`, W3C `traceparent` propagation, and mutual TLS (mTLS) with Subject CN identity checks and certificate fingerprint revocation.
- **Supporting tools:** A zero-dependency Python JSONL trace-diff CLI (`src/bisectpilot/__init__.py`) and a Next.js 16 interactive replay web console (`website/`).

---

## Requirements and Compatibility

### Core CLI Requirements (Local Bisection)

- **Node.js:** `>=20.0.0` (repository development is pinned to `v24.18.0` in `.nvmrc`)
- **Git:** `>=2.36.0`
- **Runtime dependencies:** Zero external npm runtime dependencies (`package.json` uses only Node.js built-in modules at runtime)

### Optional Component Requirements

Python, container runtimes, TLS certificates, and website dependencies are **not** required for standard local CLI bisection:

- **Rootless container sandbox (opt-in):** Requires local `docker` or `podman` configured for effective rootless execution on a non-root POSIX host, plus a pre-pulled, lowercase digest-pinned image (`<repo>@sha256:<64-hex>`).
- **Remote daemon/worker deployment (opt-in):** Requires server and client X.509 certificates, a shared CA certificate, `0600` private key permissions on POSIX, and pre-provisioned repository clones on worker hosts.
- **Python trace-diff helper (optional supporting tool):** Requires Python `>=3.12` (`pyproject.toml`; tested in CI on Python 3.11+).
- **Interactive replay website (optional supporting tool):** Located in `website/`; requires its own `npm --prefix website ci` install (Next.js 16, React 19).

---

## Installation

### Option 1 — Install from Source (Recommended)

Installing from source is the verified, recommended path for local use and development.

```bash
git clone https://github.com/priyanshu2007-cmd/BisectPilot-.git
cd BisectPilot-
npm ci
npm run build
npm link
bisectpilot --help
```

- Use the repository-pinned Node.js version (`nvm use` reads `v24.18.0` from `.nvmrc`) when possible, or any Node.js `>=20.0.0`.
- `npm link` registers the `bisectpilot` binary globally in your active Node environment for local development.
- You can also invoke the compiled CLI directly without linking (works identically across Linux, macOS, and Windows PowerShell/CMD):

```bash
node dist/src/index.js --help
node dist/src/index.js --version
```

### Option 2 — Install through GitHub Packages

The package is scoped as `@priyanshu2007-cmd/bisectpilot` and configured for the GitHub Packages registry (`https://npm.pkg.github.com`) via `.github/workflows/publish.yml`.

> **Current Publication Status:** As of the current repository state, `@priyanshu2007-cmd/bisectpilot@0.1.0` has not yet been published to the GitHub Packages registry (the release workflow is gated on tag push `v*`, GitHub Release publication, or manual `workflow_dispatch`). Until a package release is published, **use Option 1 (Install from Source)** or install from a locally packed tarball (`npm pack`).

Once a version is published to GitHub Packages, installation requires authenticating to `https://npm.pkg.github.com` with a GitHub Personal Access Token (`read:packages` scope):

1. Configure the scoped registry and token reference in your user `~/.npmrc` (never hardcode tokens in a committed `.npmrc`):

   ```ini
   @priyanshu2007-cmd:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

2. Export your read-only token in your shell and install:

   ```bash
   export NODE_AUTH_TOKEN="<YOUR_GITHUB_PAT_WITH_READ_PACKAGES>"
   npm install -g @priyanshu2007-cmd/bisectpilot
   bisectpilot --help
   ```

---

## Quick Start

Follow these steps to run your first regression bisection against a local Git repository. Replace placeholder values (`<PATH_TO_REPO>`, `<GOOD_REF>`, `<BAD_REF>`) with values from your target repository.

### 1. Check prerequisites with `doctor`

Verify that Git `>=2.36.0` is installed and that the target repository is valid:

```bash
bisectpilot doctor <PATH_TO_REPO>
```

`doctor` outputs a JSON diagnostic report showing `gitVersion`, `repoRoot`, `headSha`, `isDirty`, and `ok: true`.

### 2. Generate a starter configuration with `init`

```bash
bisectpilot init --out bisectpilot.config.json
```

This writes a validated `bisectpilot.config.json` file with `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "profile": "functional",
  "repositoryRoot": ".",
  "workingDirectory": ".",
  "goodRef": "HEAD~5",
  "badRef": "HEAD",
  "oracle": {
    "mode": "in-tree",
    "command": {
      "command": "npm",
      "args": ["test"],
      "timeoutMs": 180000
    }
  },
  "execution": {
    "maxOutputBytesPerCommand": 1000000,
    "maxRetries": 0,
    "endpointFlakeRuns": 3,
    "boundaryConfirmRuns": 3,
    "maxSkips": 10,
    "confirmBeforeExecutingCode": true,
    "cleanIgnored": false,
    "allowlistedEnvVars": [],
    "enforceNodeToolchainCheck": true,
    "interactivePrompt": false
  }
}
```

Key fields to customize:

- `repositoryRoot`: Path to the Git repository being investigated (e.g., `"."` or `"/path/to/repo"`).
- `workingDirectory`: Relative directory inside the repository where commands run (`"."` or a monorepo package path like `"packages/api"`).
- `goodRef`: Known-good Git commit SHA, tag, or ref (or `"auto"` to search backward automatically).
- `badRef`: Known-bad Git commit SHA, tag, or ref where the regression is present.
- `oracle.command`: The executable (`command`) and string arguments (`args`) that exit `0` when good and non-zero (`1`–`124`, `126`–`127`) when the regression is present.

### 3. Inspect the execution plan with `plan`

Before running any repository code, preview the resolved commit SHAs, ancestry check, commit count, and estimated bisect steps:

```bash
bisectpilot plan \
  --config bisectpilot.config.json \
  --good <GOOD_REF> \
  --bad <BAD_REF>
```

### 4. Run the bisection with `start`

Because bisection executes historical code from the repository, `confirmBeforeExecutingCode` is `true` by default. Pass `--yes` to grant explicit consent:

> **Security Warning:** Passing `--yes` executes historical repository build and test commands under your current OS user account. Do not run untrusted or hostile repository history under your normal account without enabling `--sandbox` or isolating execution inside a dedicated VM or container.

```bash
bisectpilot start \
  --config bisectpilot.config.json \
  --good <GOOD_REF> \
  --bad <BAD_REF> \
  --yes
```

`start` prints the final `SessionManifestV1` JSON, including the session `id` (for example, `bp-a1b2c3d4`), `state`, and `conclusion` (`candidateSha`, `outcome`, `explanation`).

### 5. Inspect session status and generate reports

Use the `<SESSION_ID>` from the manifest output:

```bash
# Inspect session state, lock status, and checkpoint metadata
bisectpilot status <SESSION_ID>

# Verify the SHA-256 hash chain and export a JSON report
bisectpilot report <SESSION_ID> --json --verify --out report.json

# Generate a self-contained offline HTML report
bisectpilot report <SESSION_ID> --html --out report.html

# Export Markdown formatted for a GitHub Issue or PR
bisectpilot report <SESSION_ID> --github-issue --out issue.md
```

Each completed session also writes `report.md`, `report.json`, `report.html`, and an executable `repro.sh` directly inside `.bisectpilot/sessions/<SESSION_ID>/`.

### 6. Resume or clean up the session

If a run was interrupted, resume it from its last checkpoint; when finished, remove the temporary worktree while preserving or cleaning session state:

```bash
# Resume an interrupted session without re-running classified commits
bisectpilot resume <SESSION_ID>

# Preview worktree cleanup without deleting files
bisectpilot cleanup <SESSION_ID> --dry-run

# Remove the tool-owned session worktree
bisectpilot cleanup <SESSION_ID>
```

---

## Practical CLI Reference

| Command | Purpose | Minimal Verified Example |
| :--- | :--- | :--- |
| `doctor` | Validate Git `>=2.36.0`, repository root, `HEAD`, and working tree status | `bisectpilot doctor .` |
| `init` | Write a starter `BisectConfigV1` JSON configuration file (`--force` to overwrite) | `bisectpilot init --out bisectpilot.config.json` |
| `plan` | Resolve bounds, verify ancestry, and estimate bisection steps without executing code | `bisectpilot plan --config bisectpilot.config.json` |
| `start` (alias: `run`) | Execute preflight, native `git bisect`, boundary checks, and report generation | `bisectpilot start --config bisectpilot.config.json --yes` |
| `status` | Inspect session manifest, lock state, and recovery checkpoint metadata | `bisectpilot status <sessionId>` |
| `resume` | Resume an interrupted or `needs_recovery` session using cached classifications | `bisectpilot resume <sessionId>` |
| `report` | Export Markdown, `--json`, `--html`, `--github-summary`, or `--github-issue` reports (`--verify` checks ledger) | `bisectpilot report <sessionId> --html --out report.html` |
| `cleanup` | Safely remove the session's detached Git worktree (`--dry-run` to preview) | `bisectpilot cleanup <sessionId> --dry-run` |
| `list` | List all recorded session manifests in the session root directory | `bisectpilot list` |
| `minimize` | Reduce a failure-inducing input file using Delta Debugging (`ddmin`) | `bisectpilot minimize input.txt --test node --args check.js` |
| `daemon` | Manage the local/mTLS queue coordinator (`start\|status\|stop\|enqueue\|cancel\|recover\|revoke`) | `bisectpilot daemon start --state-dir .bisectpilot/daemon` |
| `worker` | Manage an outbound pull worker (`start\|status\|stop`) with pre-provisioned repos | `bisectpilot worker status --state-dir .bisectpilot/worker` |

### Common CLI Options (`plan` and `start`)

- `--good <ref>` / `--bad <ref>`: Override `goodRef` (`auto` supported on `start`/`plan`) and `badRef` from the CLI.
- `--cwd <path>`: Set `workingDirectory` relative to `repositoryRoot` for monorepo packages.
- `--scope <path,path,...>`: Comma-separated relative paths restricting `git bisect` traversal.
- `--terms <old,new>`: Use custom Git bisect terms (e.g., `--terms fixed,broken` or `--terms fast,slow`).
- `--yes`: Consent to executing historical repository commands (`start` and `daemon enqueue`).
- `--noisy`: Enable Bayesian multi-sample evaluation for flaky tests (`start` and `minimize`).
- `--prompt`: Enable interactive terminal classification after each oracle run (`start`).
- `--background`: Enqueue a consented `start` run into a local daemon instead of blocking the terminal.
- `--sandbox <docker|podman>` & `--sandbox-image <repo@sha256:...>`: Run oracle steps inside a rootless container sandbox.
- **Performance flags:** `--metric <name>`, `--threshold <num>`, `--relative-regression <val>`, `--direction <higher_is_worse|lower_is_worse>`, `--warmup <n>`, `--samples <n>`, `--max-samples <n>`, `--alpha <n>`, `--unit <str>`.

---

## Configuration and Oracle Guide

BisectPilot validates configuration files strictly against `BisectConfigV1` (`src/contracts/config.ts`).

### Supported Oracle Modes (`oracle.mode`)

1. **`in-tree` (default):** Executes a test command that already exists inside the historical commits being bisected.
2. **`overlay`:** Copies one or more relative files (`oracle.overlayFiles`) from your current checkout into the detached worktree before testing each revision, then removes them afterward. Useful when you wrote a new regression test on `HEAD` that does not exist in older commits.
   - `oracle.overlayConflictPolicy`: Set to `"skip"` (default) or `"abort"` if a historical commit modifies a file in `overlayFiles`.
   - Overlay files are SHA-256 snapshotted at session start so mid-run edits in your working tree cannot corrupt the bisect.
3. **`external`:** Runs a script (`oracle.externalScriptPath`, a safe relative path inside the repository) snapshotted into the session directory before bisection begins.
4. **Interactive prompting (`execution.interactivePrompt: true` or `--prompt`):** Displays command output at each step and prompts a human operator to classify the commit (`good`, `bad`, `skip`, or `abort`), recording `"classifiedBy": "human"` in the ledger.
5. **Noisy/flaky oracle (`execution.noisyOracle.enabled: true` or `--noisy`):** Evaluates each commit up to `maxSamplesPerRevision` (default `5`) times using closed-form Bayesian posterior updates ($P(\text{bad}) = \frac{1}{1 + r^{\text{passes} - \text{fails}}}$) with `flakeRate` (default `0.10`) and early stopping at `confidenceThreshold` (default `0.90`).

### Optional Lifecycle Hooks & Toolchain Wrappers

- `prepare`: Optional `CommandSpec` (`command`, `args`, `timeoutMs`, `cwdRelative`) run before `build` and `oracle` (e.g., dependency installation). Failures classify the revision as `skip` (`125`), never `bad`.
- `build`: Optional `BuildCommandSpec` with `failurePolicy: "skip" | "abort"` (default `"skip"`). Broken historical builds are skipped rather than blamed as test regressions.
- `execution.toolchainWrapper`: Wraps commands in a version manager (for example, `{"command": "fnm", "args": ["exec", "--using=20"]}`) when historical commits require a specific runtime.

### Valid Configuration Example (Overlay + Prepare/Build)

```json
{
  "schemaVersion": 1,
  "profile": "functional",
  "repositoryRoot": ".",
  "workingDirectory": "packages/core",
  "goodRef": "v1.2.0",
  "badRef": "HEAD",
  "prepare": {
    "command": "npm",
    "args": ["ci", "--ignore-scripts"],
    "timeoutMs": 120000
  },
  "build": {
    "command": "npm",
    "args": ["run", "build"],
    "timeoutMs": 60000,
    "failurePolicy": "skip"
  },
  "oracle": {
    "mode": "overlay",
    "overlayFiles": ["packages/core/tests/regression-issue-42.test.js"],
    "overlayConflictPolicy": "skip",
    "command": {
      "command": "node",
      "args": ["--test", "packages/core/tests/regression-issue-42.test.js"],
      "timeoutMs": 30000
    }
  },
  "execution": {
    "maxOutputBytesPerCommand": 1000000,
    "maxRetries": 0,
    "endpointFlakeRuns": 3,
    "boundaryConfirmRuns": 3,
    "maxSkips": 10,
    "confirmBeforeExecutingCode": true,
    "cleanIgnored": false,
    "allowlistedEnvVars": ["NODE_OPTIONS"],
    "enforceNodeToolchainCheck": true,
    "interactivePrompt": false
  }
}
```

### Diagnosing Common Configuration Errors

Run `bisectpilot plan --config <file>` to validate configuration and repository state before starting a session. If validation fails, the CLI exits with code `2` and prints structured JSON validation issues (`[{"path": "...", "message": "..."}]`):

- **Path traversal rejected:** `workingDirectory`, `oracle.overlayFiles`, and `oracle.externalScriptPath` must stay inside `repositoryRoot` and cannot use `..` escapes or symlinks pointing outside the repo.
- **Invalid bisect terms:** `terms.old` and `terms.new` cannot be identical, contain whitespace/Git ref special characters, or use reserved Git bisect subcommands (`start`, `skip`, `reset`, `run`, `log`, `replay`, `view`, `visualize`, `help`, `terms`).
- **Sandbox policy errors:** `execution.sandbox.image` must match `<lowercase-repo>@sha256:<64-lowercase-hex>`. `interactivePrompt`, `envOverrides`, and secret-like `allowlistedEnvVars` (`TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, `AWS_`, `GCP_`, `AZURE_`) are rejected when sandboxing is enabled.

---

## Monorepo and Performance Workflows

### Monorepo Package Scoping (`--cwd` and `--scope`)

When bisecting a regression inside a monorepo package:

```bash
# Automatically scopes git bisect to packages/api plus root lockfiles/manifests
bisectpilot plan --config bisectpilot.config.json --cwd packages/api
bisectpilot start --config bisectpilot.config.json --cwd packages/api --yes

# Explicitly restrict additional relative paths
bisectpilot start --config bisectpilot.config.json --cwd packages/api --scope packages/api,packages/shared --yes
```

- When `--cwd <pkg>` is set without an explicit `--scope`, BisectPilot automatically passes `-- <pkg>` plus existing root dependency/workspace manifests (`package.json`, `package-lock.json`, `pnpm-lock.json`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lockb`, `lerna.json`, `turbo.json`, `nx.json`, `.nvmrc`, `.node-version`, `tsconfig.json`) to `git bisect start`.
- If `git bisect` checks out a historical commit where the `--cwd` directory did not yet exist, BisectPilot classifies that commit as `skip` (`untestable_revision`) rather than failing.
- SHA-256 hashes of root and package manifests are recorded in each ledger event.

### Performance Regression Bisection (`--metric`)

When investigating a latency or throughput regression rather than a pass/fail test failure:

```bash
bisectpilot start \
  --config bisectpilot.config.json \
  --metric p95_latency_ms \
  --unit ms \
  --threshold 120 \
  --relative-regression 15% \
  --direction higher_is_worse \
  --warmup 1 \
  --samples 5 \
  --max-samples 10 \
  --alpha 0.05 \
  --yes
```

- **Metric output format:** Your oracle command must print the metric to `stdout` or `stderr` as JSON (e.g., `{"p95_latency_ms": 142.5}` or `{"metrics": {"p95_latency_ms": 142.5}}`) or key-value text (e.g., `p95_latency_ms: 142.5 ms`). Non-finite values (`NaN`, `Infinity`) or unit mismatches are rejected.
- **Decision rule:** Preflight collects baseline statistics at `goodRef` and verifies the regression at `badRef`. During bisection, a revision is classified `bad` only when it breaches the practical threshold (`--threshold` and/or `--relative-regression`) **and** achieves statistical significance ($p < \alpha$ via Welch's two-sample t-test).
- **Limitations:** Statistical tests reduce false positives from normal variance on a quiet machine, but they cannot eliminate host-level CPU contention, thermal throttling, or external network jitter. Run performance bisections on an idle machine with sufficient `--warmup` and `--samples`, and treat high-variance `inconclusive` outcomes as a signal to increase sample counts or quiet the host.

### Flaky / Noisy Test Bisection (`--noisy`)

When a test fails intermittently on broken commits:

```bash
bisectpilot start \
  --config bisectpilot.config.json \
  --noisy \
  --yes
```

- Uses sequential Bayesian updates with configurable `maxSamplesPerRevision` (`5`), `confidenceThreshold` (`0.90`), and `flakeRate` (`0.10`). If confidence does not reach the threshold within the sample budget, the revision is marked `skip` (`125`) rather than guessing.

---

## Safety Model

BisectPilot enforces strict operational invariants to protect developer checkouts and preserve honest evidence:

1. **Primary Checkout Preservation:** BisectPilot never runs `git bisect`, `git checkout`, `git reset`, or `git clean` in your primary working tree. All checkouts happen inside `.bisectpilot/sessions/<sessionId>/worktree`.
2. **Mandatory 5-Point Worktree Ownership Guard:** Before resetting or deleting any worktree (`verifyWorktreeOwnership`), the engine verifies `createdByTool === true`, realpath inequality with your primary repository root, realpath equality with the recorded session worktree path, matching `git-common-dir`, and a valid `bisectpilot-owned.json` marker matching the session ID.
3. **Honest 4-Kind Classification Contract:** Every evaluation maps to `good` (`0`), `bad` (`1`), `skip` (`125`), or `abort` (`128`). Command timeouts (`skip` -> `125`), build/prepare failures (`skip` -> `125`), and missing executables (`abort` -> `128`) are **never** misclassified as confirmed regressions (`bad`). Exit codes `126` and `127` are never emitted by the bisect runner.
4. **Shell-Free & Deterministic Subprocesses:** Commands are spawned via `child_process.spawn(cmd, args, { shell: false })` with bounded output buffers (`maxOutputBytesPerCommand`) and deterministic environment defaults. On POSIX, child processes run in detached process groups so timeouts clean up grandchild processes (`SIGTERM` then `SIGKILL`).
5. **Worktree != OS Security Sandbox:** A Git worktree isolates working files and `refs/bisect/*` state, **not** OS processes, files outside the worktree, or network access. Direct local execution runs historical repository code with your user permissions and therefore requires explicit `--yes` consent.
6. **Opt-In Rootless Container Sandbox:** When `--sandbox docker|podman` and a local lowercase digest-pinned `--sandbox-image` are provided, preflight verifies a local runtime endpoint, rootless mode, and non-root POSIX UID/GID. Containers run with `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, bounded CPU/memory/PIDs/tmpfs, and container ownership inspection before start. Sandbox failures never fall back to unsandboxed host execution.
7. **Fail-Closed Recovery:** Session resumption refuses to run if a live process holds the session lock, if repository/worktree identity or config/overlay hashes changed, if ownership markers are missing, if the ledger hash chain is broken, or if `schemaVersion` is unsupported.

See [`docs/safety-model.md`](docs/safety-model.md) for the complete safety specification.

---

## Session Recovery and Evidence Reports

### Session Artifacts

Every session directory (`.bisectpilot/sessions/<sessionId>/`) stores:

- `ledger.jsonl`: Append-only, SHA-256 hash-chained write-ahead log of all session events.
- `manifest.json`: Current `SessionManifestV1` snapshot.
- `checkpoint.json` & `checkpoint.backup.json`: Checksummed recovery snapshots written via temporary file + `fsyncSync` + atomic rename (and directory `fsyncSync` on POSIX).
- `report.json`, `report.md`, `report.html`, `repro.sh`: Automatically written when a session concludes.

### Inspecting and Resuming Interrupted Sessions

If a bisection process is killed (for example, `SIGKILL` or terminal closure):

```bash
# 1. Inspect the session; detects stale locks from dead PIDs and reports state: "needs_recovery"
bisectpilot status <sessionId>

# 2. Resume the session; reuses cached classifications from checkpoint/WAL without re-running tests
bisectpilot resume <sessionId>
```

- **Durability scope:** Process crashes (`SIGKILL` / abrupt process exit) are crash-consistent via atomic rename, backup checkpoint fallback, and `ledger.jsonl` replay. OS crashes and sudden hardware power loss are best-effort via POSIX file/directory `fsyncSync`; if underlying storage hardware drops unflushed writes, recovery falls back to `checkpoint.backup.json` or `ledger.jsonl` and fails closed if the hash chain is damaged.

### Generating and Verifying Reports

```bash
# Print Markdown report to stdout (or save with --out) while verifying the ledger hash chain
bisectpilot report <sessionId> --verify --out report.md

# Export structured JSON report and verify hash chain integrity
bisectpilot report <sessionId> --json --verify --out report.json

# Generate standalone offline HTML report (zero external network/CDN requests)
bisectpilot report <sessionId> --html --out report.html

# Append a GitHub Actions Markdown summary to $GITHUB_STEP_SUMMARY or a target file
bisectpilot report <sessionId> --github-summary summary.md

# Export copy-paste Markdown for a GitHub Issue or Pull Request
bisectpilot report <sessionId> --github-issue --out issue.md
```

See [`docs/architecture.md`](docs/architecture.md) for details on the ledger and checkpoint architecture.

---

## Daemon and Remote Worker Setup

Ordinary single-machine CLI usage (`bisectpilot start`) does **not** require a daemon or worker. The daemon and worker commands are optional components for background queuing or coordinating workers across pre-provisioned repositories.

### Local Loopback Queue Workflow

By default, the daemon binds to `127.0.0.1:4317` over HTTP using a generated `0600` bearer token file in `.bisectpilot/daemon`:

```bash
# Start local daemon in background
bisectpilot daemon start --state-dir .bisectpilot/daemon

# Check daemon status and telemetry summary
bisectpilot daemon status --state-dir .bisectpilot/daemon

# Enqueue a consented bisection job (requires explicit goodRef, not "auto")
bisectpilot daemon enqueue --config bisectpilot.config.json --yes --state-dir .bisectpilot/daemon

# Start a local pull worker mapped to a pre-provisioned repository path
bisectpilot worker start \
  --state-dir .bisectpilot/worker \
  --server http://127.0.0.1:4317 \
  --token-file .bisectpilot/daemon/daemon.token \
  --repo default=/absolute/path/to/repo

# Stop worker and daemon cleanly
bisectpilot worker stop --state-dir .bisectpilot/worker
bisectpilot daemon stop --state-dir .bisectpilot/daemon
```

### Remote Mutual TLS (mTLS) Workflow

Binding the daemon to a non-loopback address requires HTTPS with server and CA certificates (`--tls-cert`, `--tls-key`, `--tls-ca`, `--tls-require-client-cert`), and remote workers refuse plaintext HTTP URLs. In mTLS mode, the daemon verifies the worker certificate's Subject Common Name (`CN`) against `--worker-id`, checks certificate SHA-256 fingerprints against `revocations.json` on every request, and enforces monotonic lease fencing tokens.

- Follow [`docs/multimachine-mtls-setup.md`](docs/multimachine-mtls-setup.md) for PKI generation, certificate SAN/CN rules, deployment commands, and certificate revocation (`bisectpilot daemon revoke`).
- **Verification note:** Mutual TLS handshakes, CN authorization, dynamic credential rotation, and fingerprint revocation are verified by automated loopback integration tests (`tests/integration/mtls-remote-worker.test.ts`), but deployment across separate physical hosts has not been independently verified in CI.

---

## Python Helper and Website

BisectPilot includes two optional supporting tools alongside the main TypeScript Git bisection CLI.

### 1. Python JSONL Trace-Diff Utility (`src/bisectpilot/__init__.py`)

A zero-dependency Python utility (`pyproject.toml` entry point `bisectpilot = "bisectpilot:main"`) for comparing baseline and candidate JSONL execution traces, identifying the first turn where output drifts, and exporting scenarios for the replay console.

```bash
# Run Python unit tests
npm run test:py

# Run the Python CLI entry point directly from source (POSIX)
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" --help
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" diff baseline.jsonl current.jsonl --out scenario.json
PYTHONPATH=src python3 -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" bisect baseline.jsonl..current.jsonl --export-web
```

On Windows PowerShell:

```powershell
$env:PYTHONPATH="src"; python -c "import sys, bisectpilot; raise SystemExit(bisectpilot.main(sys.argv[1:]))" --help
```

### 2. Next.js Interactive Replay Website (`website/`)

A static Next.js 16 web application providing product documentation (`/docs`) and an interactive replay console (`/explorer`) that visualizes sample scenarios or imports `bisectpilot report <sessionId> --json` files via drag-and-drop.

```bash
npm --prefix website ci
npm --prefix website run dev
# Open http://localhost:3000
```

---

## Development and Testing

### Root Package Commands

```bash
# Install root dependencies
npm ci

# Compile TypeScript (src/ and tests/) to dist/
npm run build

# Run strict TypeScript typechecking without emitting files
npm run typecheck

# Compile and run all TypeScript unit, integration, and safety test suites
npm test
```

### Focused Test Suites

```bash
# Run only unit, integration, or safety suites via the cross-platform test runner
npm run test:unit
npm run test:integration
npm run test:safety

# Run a single compiled integration test file directly
node --test dist/tests/integration/fresh-clone-e2e.test.js
node --test dist/tests/integration/session-resume-recovery.test.js
node --test dist/tests/integration/mtls-remote-worker.test.js
node --test dist/tests/integration/package-distribution.test.js
```

### Python and Website Test Commands

```bash
# Run Python trace-diff unit tests (4 tests)
# Note: npm run test:py uses inline `PYTHONPATH=src` syntax, which requires a POSIX shell (Linux/macOS/Git Bash)
npm run test:py

# Cross-platform Python test command (works in Windows PowerShell/CMD and POSIX)
python -m unittest discover -s tests -v   # with PYTHONPATH=src set in environment

# Install and validate the Next.js website (typecheck + ESLint + production static build)
npm --prefix website ci
npm --prefix website run test
```

### Packaging Check

```bash
# Verify tarball contents without publishing
npm pack --dry-run
```

---

## Known Limitations and Current Status

### What Is Implemented and Verified

- **Core Engine & CLI:** End-to-end Git bisection in isolated worktrees, `in-tree` / `overlay` / `external` oracles, `--good auto` discovery, custom `--terms`, `--noisy` Bayesian sampling, `--prompt` interactive classification, `minimize` (`ddmin`), monorepo `--cwd`/`--scope`, performance benchmark bisection, session checkpointing/recovery (`fsyncSync` + WAL replay), and JSON/Markdown/HTML/GitHub reports.
- **Automated Test Suite:** Verified locally and in GitHub Actions CI (`ubuntu-latest`, `macos-latest`, `windows-latest` across Node.js `20.x` and `22.x`), covering 229 TypeScript tests across 29 suites (228 passing, 1 environment-gated real-container test), 4 Python unit tests, isolated tarball consumer installation (`package-distribution.test.js`), Next.js static build verification, CodeQL analysis, and Gitleaks secret scanning.

### What Remains Environment-Dependent or Unverified

- **GitHub Packages Registry Publication:** `@priyanshu2007-cmd/bisectpilot` is validated via `npm pack` and isolated consumer installation in CI, but has not yet been published to `https://npm.pkg.github.com`. Install from source (`git clone` + `npm ci` + `npm run build`).
- **Real Rootless Container Sandbox Execution:** The sandbox runtime boundary is tested with deterministic mock executors across all platforms, and the real-runtime integration test (`dist/tests/integration/sandbox-runtime.test.js`) runs only when a host provides an operational rootless Docker/Podman runtime and `BISECTPILOT_SANDBOX_IMAGE` is set to a local digest-pinned image. On macOS or Linux hosts without user-namespace `subuid`/`subgid` rootless Podman/Docker configured, the real-container test is skipped.
- **Physical Multi-Machine mTLS Deployment:** Daemon/worker mTLS transport, certificate validation, and lease fencing are verified on loopback (`127.0.0.1`), but cross-host deployment over physical network hardware has not been verified in an automated multi-machine environment.
- **OS Crash / Hardware Power Loss:** Checkpoint durability uses temporary files, `fsyncSync`, atomic rename, and POSIX directory `fsyncSync`, which guarantees recovery across process crashes (`SIGKILL`), but physical power-loss durability remains dependent on host filesystem and disk controller flush behavior.
- **POSIX Shell Script in `npm run test:py`:** The `test:py` script in `package.json` uses POSIX `PYTHONPATH=src python3 ...` syntax; on native Windows shells (PowerShell/CMD), set `PYTHONPATH=src` via environment variables and invoke `python -m unittest discover -s tests -v` (as done in `.github/workflows/ci.yml`).

---

## License and Helpful Links

### License

Released under the [MIT License](LICENSE).

### Documentation & Repository Links

- [Architecture Overview (`docs/architecture.md`)](docs/architecture.md)
- [Safety Model (`docs/safety-model.md`)](docs/safety-model.md)
- [Multi-Machine mTLS Runbook (`docs/multimachine-mtls-setup.md`)](docs/multimachine-mtls-setup.md)
- [Engineering Handoff & Operational Guide (`docs/handoff.md`)](docs/handoff.md)
- [Master Plan Specification (`docs/bisectpilot-master-plan-v3.md`)](docs/bisectpilot-master-plan-v3.md)
- [Website Documentation (`website/README.md`)](website/README.md)
- [GitHub Actions CI Workflow (`.github/workflows/ci.yml`)](.github/workflows/ci.yml)
- [GitHub Issues](https://github.com/priyanshu2007-cmd/BisectPilot-/issues)
