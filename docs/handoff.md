# Cross-Agent Handoff Log (`agent-a/engine` <-> `agent-b/experience`)

## Milestone G0 + Steps 1–4 — Full Engine Architecture & Reliability Suite

- **Branch:** `agent-a/engine`
- **Status:** Completed & Verified (85/85 TypeScript unit + real-Git integration tests passing; 4/4 Python trace diff tests passing; website build clean).
- **ADR & Documentation:**
  - [`docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md)
  - [`docs/architecture.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/architecture.md)
  - [`docs/safety-model.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/safety-model.md)
  - [`docs/bisectpilot-master-plan-v3.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/bisectpilot-master-plan-v3.md)
- **Key Implemented Capabilities:**
  - `src/contracts/` — Frozen contracts, `CustomBisectTerms`, `NoisyOraclePolicy`, and `FakeEngine` re-export.
  - `src/config/index.ts` — Config validation, terms parsing (`parseTermsOption`, `validateBisectTerm`), and hashing.
  - `src/domain/bayesian.ts` — Closed-form Bayesian posterior calculations ($P(\text{bad}) = \frac{1}{1 + r^{\text{passes} - \text{fails}}}$) and early stopping evaluation.
  - `src/domain/classification.ts` — 4-kind classification (`good`, `bad`, `skip`, `abort`) with `noisySampling` metadata support.
  - `src/git/index.ts` — Git ref resolution, ancestry checks, and exponential candidate discovery for `--good auto`.
  - `src/worktree/index.ts` — Detached session worktree management and post-revision reset.
  - `src/process/index.ts` — Shell-free process runner, POSIX process-group / Windows `taskkill` process-tree termination.
  - `src/oracle/index.ts` — Multi-sample noisy oracle loop, interactive classification prompt (`--prompt`), toolchain inspection, and overlay/external modes.
  - `src/ledger/index.ts` — Append-only hash-chained JSONL evidence ledger with `terms` and `noisySampling` telemetry.
  - `src/reports/index.ts` — Secret redaction, JSON/Markdown reports, report replay normalization, and standalone `repro.sh` generator.
  - `src/application/index.ts` — `LocalBisectEngine` coordinating discovery, noisy preflight flake tolerances, `--term-old`/`--term-new` native Git bisect arguments, boundary confirmation, and resume.
  - `src/cli/index.ts` — Full CLI dispatch supporting `--terms`, `--noisy`, `--prompt`, `--good auto`, `plan`, `start`, `resume`, `report`, `cleanup`, `list`.
- **Verification Commands & Real Results:**
  - `npm run typecheck` -> passed (`tsc -p tsconfig.json --noEmit`, exit 0)
  - `npm test` -> passed (85/85 tests across 11 suites in ~9.6s)
  - `npm run test:py` -> passed (4/4 tests in 0.004s)
  - `npm --prefix website run test` -> passed (typecheck, lint, build clean)
  - `git diff --check` -> passed (exit 0)
- **CI & Release-Hardening:**
  - GitHub Actions matrix workflow deployed at `.github/workflows/ci.yml` (`ubuntu-latest`, `macos-latest`, `windows-latest` across Node 20 & 22).
  - Overrides configured for `braces@^3.0.3` in `website/package.json`.
  - `FakeEngine` moved to test fixtures (`tests/fixtures/fake-engine.ts`).
