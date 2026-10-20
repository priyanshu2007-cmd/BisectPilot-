# BisectPilot

> Local-first Git regression bisection engine that wraps native `git bisect` with isolated worktrees, boundary confirmation, and tamper-evident evidence ledgers.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 60-Second Quickstart

Bisect a regression without creating a configuration file:

```bash
npx bisectpilot start --good v1.0.0 --bad HEAD --yes -- npm test
```

### Verified Output

```text
[progress] session bp-18d857d5 created
[progress] state created -> awaiting_consent
[progress] state awaiting_consent -> worktree_ready
[progress] state worktree_ready -> preflight_running
[progress] good_endpoint boundary 3/3 passed
[progress] bad_endpoint boundary 0/3 passed
[progress] state preflight_running -> bisect_running
[progress] state bisect_running -> boundary_verifying
[progress] candidate boundary 0/3 passed
[progress] candidate_parent boundary 3/3 passed
[progress] state boundary_verifying -> concluded

Session: bp-18d857d5
Result: OK
State: concluded
Outcome: candidate_confirmed
Candidate: a2caead1 — Add "week" / "w" support
Parent: e359eee3 — Add reference to ms.macro (#99)
Evaluated revisions: 7
Skipped revisions: 0
Summary: Confirmed a2caead13ac7f9931338a1a51ab4e36ddb505e00 as first bad commit (3/3 bad; parent e359eee3 3/3 good).
```

Verify the cryptographic SHA-256 evidence chain:

```bash
npx bisectpilot report --verify
# OK Ledger verified: 48 events, hash chain intact
```

---

## Why BisectPilot vs. Bare `git bisect run`

| Capability | Bare `git bisect run` | BisectPilot |
|---|---|---|
| **Working Directory** | Mutates and dirties active checkout | Runs in isolated, detached session worktrees; preserves original HEAD and dirty files |
| **Endpoint Sanity** | Blindly runs even if good fails or bad passes | Mandatory preflight validates both endpoints with multi-run flakiness checks |
| **Boundary Confirmation** | Stops at first failing commit without re-check | Automatically re-verifies both candidate and parent commit boundaries (3/3 runs) |
| **Skipped Revisions** | Reports arbitrary single commit on skips | Reports honest candidate ambiguity ranges (`candidate_range_unresolved`) |
| **Audit Trail** | None; ephemeral terminal output | Tamper-evident append-only SHA-256 hash-chained JSONL evidence ledger |
| **Reporting** | Raw terminal stdout | Standalone offline HTML, GitHub Markdown, and structured JSON reports |
| **Crash Recovery** | Manual recovery; risks corrupted bisect state | Durable WAL checkpoint with stale lock recovery and safe zero-work resumption |
| **Zero Dependencies** | Shell-only | Zero runtime npm dependencies; Node.js `>=20` built-ins |

---

## Installation & Prerequisites

**Prerequisites**: Node.js `>=20.0.0` and Git `>=2.36.0`.

### Run via `npx` (No Install)

```bash
npx bisectpilot start --good v1.0.0 --bad HEAD --yes -- npm test
```

### Global Install

```bash
npm install -g @priyanshu2007-cmd/bisectpilot
bisectpilot doctor .
```

### Install from Source

```bash
git clone https://github.com/priyanshu2007-cmd/BisectPilot.git
cd BisectPilot
npm install
npm run build
npm test
npm link
```

---

## CLI Command Reference

| Command | Description |
|---|---|
| `bisectpilot doctor [path]` | Verify Git version, safe directories, repository health, and prerequisites |
| `bisectpilot init [--out cfg]` | Generate a validated starter `bisectpilot.config.json` |
| `bisectpilot plan [options]` | Validate revision bounds and estimate required bisection steps |
| `bisectpilot start [options] -- <cmd>` | Execute bisection with inline command or config (`run` alias supported) |
| `bisectpilot status [options]` | Inspect session state, lock status, tested revisions, and recovery needs |
| `bisectpilot resume [options]` | Resume interrupted or crashed session from checkpoint without repeating tests |
| `bisectpilot report [options]` | Export Markdown, HTML, JSON reports or verify ledger hash chain (`--verify`) |
| `bisectpilot cleanup [options]` | Safely remove tool-owned session worktree without deleting tracked files |
| `bisectpilot list` | List recorded bisection sessions in the repository |
| `bisectpilot minimize [options]` | Automated Delta-Debugging input minimizer (`ddmin`) |
| `bisectpilot daemon [subcmd]` | Optional background job queue manager (`start`, `stop`, `status`, `enqueue`) |
| `bisectpilot worker [subcmd]` | Optional background pull worker (`start`, `run-once`) |

---

## Execution Safety & Consent

BisectPilot prioritizes safety when checking out historical revisions:

1. **Explicit Execution Consent**: Executing arbitrary test commands across historical revisions requires the explicit `--yes` flag (or `confirmBeforeExecutingCode: false` in config).
2. **Worktree Isolation**: Operations run in `.bisectpilot/sessions/<id>/worktree`. Your primary working tree and uncommitted changes are never touched.
3. **Automatic Exclusion**: `.bisectpilot/` is automatically and idempotently added to `.git/info/exclude`.
4. **Rootless Sandbox (Optional)**: Run untrusted tests inside a rootless container:
   ```bash
   bisectpilot start --good v1.0 --bad HEAD --yes \
     --sandbox-runtime docker \
     --sandbox-image node:20-alpine@sha256:d84... \
     -- npm test
   ```

---

## Documentation

- [Architecture & Design](docs/architecture.md)
- [Configuration & Oracle Modes](docs/configuration.md)
- [Performance Regression Bisection](docs/performance.md)
- [Monorepo & Multi-Package Workspaces](docs/monorepo.md)
- [Flaky & Noisy Test Multi-Sampling](docs/flaky-tests.md)
- [Session Recovery & Evidence Reports](docs/recovery-and-reports.md)
- [Distributed Daemon & Workers](docs/daemon-and-workers.md)
- [Rootless Container Sandbox](docs/sandbox.md)
- [Development & Testing Guide](docs/development.md)
- [Examples & Public Walkthroughs](examples/README.md)
- [Roadmap](docs/roadmap.md)

---

## License

[MIT](LICENSE)
