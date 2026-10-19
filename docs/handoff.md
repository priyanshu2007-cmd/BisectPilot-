# Cross-Agent Handoff Log (`agent-a/engine` <-> `agent-b/experience`)

## Milestone G0 + A1–A10 — Microlithic Engine Architecture & Verification

- **Branch:** `agent-a/engine`
- **Status:** Completed & Verified (13/13 TypeScript unit + real-Git integration tests passing; 4/4 Python trace diff tests passing).
- **ADR & Documentation:**
  - [`docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md)
  - [`docs/architecture.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/architecture.md)
  - [`docs/safety-model.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/safety-model.md)
- **Microlithic Modules (`src/`):**
  - `src/contracts/` — Frozen G0 contracts (`config.ts`, `outcome.ts`, `ledger.ts`, `session.ts`, `engine.ts`, `index.ts`)
  - `src/config/index.ts` — Config loader, validator, and SHA-256 config hashing
  - `src/domain/classification.ts` & `src/domain/index.ts` — 4-kind classification (`good` -> `0`, `bad` -> `1`, `skip` -> `125`, `abort` -> `128`, never `126`/`127`)
  - `src/git/index.ts` & `src/adapters/git/git-client.ts` — Git >= 2.36 version check, ref resolution, ancestry, and `doctor` diagnostics
  - `src/worktree/index.ts` & `src/adapters/git/worktree-manager.ts` — Detached worktree creation, `verifyWorktreeOwnership()`, `resetOwnedWorktree()`, and `removeOwnedWorktree()`
  - `src/process/index.ts`, `src/adapters/process/process-runner.ts` & `environment-policy.ts` — `shell: false` execution, POSIX `-pid` process-group termination, output caps, and restricted deterministic environment
  - `src/oracle/index.ts` — `in-tree`, `overlay` (SHA-256 snapshotted with tracked-file conflict check and guaranteed `finally` cleanup), and `external` oracle modes + Node toolchain check
  - `src/ledger/index.ts` — Append-only hash-chained JSONL evidence ledger & `verifyLedgerChain()`
  - `src/session/index.ts` — Atomic manifest persistence, `transitionSessionState()`, lockfile management, and crash recovery detection
  - `src/runner/bisect-runner.ts` — External stable runner invoked via `process.execPath` during `git bisect run`
  - `src/application/index.ts` — `LocalBisectEngine` implementing `BisectEngine` (`doctor`, `plan`, `start`, `status`, `resume`, `cleanup`, `list`)
  - `src/reports/index.ts` — Secret redaction (`redactSensitiveText`), Markdown report generator, and `repro.sh` generator
  - `src/cli/index.ts` & `src/index.ts` — Cohesive CLI entry point and microlithic barrel exports
  - `src/bisectpilot/__init__.py` — Preserved Python JSONL trace diff CLI
- **Verification Commands & Real Results:**
  - `npm run typecheck` -> passed (`tsc -p tsconfig.json --noEmit`, exit 0)
  - `npm test` -> passed (13/13 tests across 5 suites in 3.25s)
  - `npm run test:py` -> passed (4/4 tests in 0.004s)
  - `node dist/src/index.js --help` -> passed (exit 0)
  - `git diff --check` -> passed (exit 0)
- **Remaining / Future Work (P1/P2):**
  - Bayesian noisy-oracle bisection mode (`P1`), `--good auto` exponential endpoint search (`P1`), interactive `--prompt` human classification (`P1`), and expanded multi-repo fixture matrix (`B1`/`B7`).
