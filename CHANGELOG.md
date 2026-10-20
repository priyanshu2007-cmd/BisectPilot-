# Changelog

All notable changes to BisectPilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

- **Human-Readable Default Output**: `bisectpilot start` and concluding `resume` now output a clean, human-readable summary by default. Automated tools and CI scripts requiring the machine-readable session manifest must pass the `--json` flag.
- **Strict Command-Line Validation**: Replaced legacy argument parsing with strict `node:util.parseArgs` validation across all subcommands. Unrecognized flags and malformed numeric parameters (e.g. invalid ports, negative timeouts, non-finite bounds) now terminate with a descriptive error and exit code 2.

### Added

- **External Hash Anchoring**: Anchor final cryptographic chain hash in session manifests and report artifacts, with `--expect-hash <hex>` verification in `bisectpilot report --verify` to protect against full-chain rewrites.
- **Zero-Config Inline Oracle Commands**: Support executing inline test commands directly after `--` without requiring a configuration file (e.g., `bisectpilot start --good v1.0 --bad HEAD --yes -- npm test`).
- **Subcommand-Specific Help**: Detailed contextual help for every CLI command and nested subcommand (`doctor`, `plan`, `start`, `status`, `resume`, `report`, `cleanup`, `list`, `minimize`, `daemon`, `worker`).
- **Ledger Verification UX**: Running `bisectpilot report --verify` now emits an explicit verification confirmation to `stderr` (`OK Ledger verified: <N> events, hash chain intact`) when the hash chain is valid, keeping `stdout` clean for piping and report output.
- **Concise Report Evaluation Rows**: Consecutive evaluations of the same commit (such as endpoint flakiness checks, noisy sampling, and boundary confirmation) are collapsed into a single summary row in Markdown and HTML reports (e.g., `fff6c4f1 · good · 3/3 runs` or mixed `2/3 bad, 1/3 good`), leaving the underlying ledger and JSON output uncollapsed.
- **Reproducible Examples**: Added `examples/README.md` with an end-to-end verified walkthrough on the public `vercel/ms` regression scenario, plus an offline, self-contained `examples/planted-regression/run.sh` script.
- **Modular Documentation**: Restructured repository documentation into dedicated guides under `docs/` (`configuration.md`, `monorepo.md`, `performance.md`, `flaky-tests.md`, `recovery-and-reports.md`, `daemon-and-workers.md`, `sandbox.md`, `development.md`, `publishing.md`).

### Fixed

- **Ledger Manifest Recovery & Integrity**: Point reconstructed session manifests at `ledger.jsonl` instead of `events.jsonl`, migrate legacy manifests safely, and fail verification immediately if the ledger is missing or empty.
- **Resumable Interrupted Sessions**: Safely transition aborted or interrupted sessions to `paused`, detect `bisect_running` state with unlocked process as `needs_recovery`, and eliminate duplicate `bisect_running` state machine transitions on resume.
- **Bisection Runner Abort & Classification Safety**: Propagate abort signals into child process groups, exit with code 128 on interrupt, and prevent recording or caching `abort` as a good/bad/skip revision classification in checkpoints.
- **Process Exit & Orphan Child Process Cleanup**: Finalize process executions on exit event without waiting for stdio closure to prevent false timeouts from orphaned background children; cleanly terminate orphaned process groups with drain timers.
- **Reproduction Script Shell Quoting & Sanitization**: Reject control characters in configuration paths, sanitize script comments, and single-quote paths containing spaces, dollar signs, and shell metacharacters in `repro.sh`.
- **Consistent Session-Root Resolution**: Resolve session directories relative to the Git top-level repository across `start`, `status`, `report`, `resume`, `cleanup`, `list`, and daemon operations, supporting execution from repo subdirectories and custom roots.
- **Reproduction Script Profile & Skip Fidelity**: Map exit code 125 to `skip` in `repro.sh` (exiting with code 2), add statistical comparison guidance for performance profile sessions, and document noisy sampling flakiness.
- **Live Session Lock Protection**: Refuse destructive `cleanup` while a live session process owns the session lock, preserving active sessions and worktrees.
- **Optimized Ledger Append & Torn-Tail Recovery**: Eliminate quadratic full-file reads on ledger append by reading only the trailing 64 KB, automatically truncate torn final lines with an explicit `ledger_repaired` audit event, and hard-fail on corrupt middle records.
- **Target Repository Status Cleanliness**: Added idempotent exclusion of `.bisectpilot/` in the target repository's `.git/info/exclude` file during session creation, preventing `git status` from being dirtied without altering tracked `.gitignore` files.
- **Hermetic CLI Doctor Test**: Decoupled the `doctor` CLI test from ambient working directory state by testing against an isolated fixture repository.

### Refactored

- **Lazy Daemon and Worker Module Loading**: Dynamically import `daemon` and `worker` execution modules on demand, keeping core CLI startup lean.
- **Typed Worker & Engine Interfaces**: Replaced `as any` casts with type guards and typed optional evaluation methods across `worker`, `runner`, `oracle`, and `daemon`.
- **Module Deconstruction**: Split large modules (`src/application`, `src/oracle`, `src/daemon`) into cohesive, single-responsibility submodules while preserving all public exports and security invariants.
- **Packaging Hygiene**: Untracked local development tooling and personal agent artifacts; configured package distribution to ship only production-compiled artifacts (`dist/src/**/*.js`, `dist/src/**/*.d.ts`), `README.md`, and `LICENSE` with zero runtime dependencies.
