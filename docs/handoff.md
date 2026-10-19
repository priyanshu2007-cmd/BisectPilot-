# Cross-Agent Handoff Log (`agent-a/engine` <-> `agent-b/experience`)

## Milestone G0 — Shared Contracts & TypeScript Scaffold (Frozen)

- **Branch:** `agent-a/engine`
- **Status:** Completed & Frozen; Agent B review requested.
- **ADR:** [`docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md`](file:///Users/priyanshu/Documents/BisectPilot/docs/decisions/0001-phase-g0-contracts-and-ts-scaffold.md)
- **Frozen Contract Files (`src/contracts/`):**
  - `src/contracts/config.ts` (`BisectConfigV1`, `OracleSpec`, `ExecutionPolicy`, `DETERMINISTIC_ENV_DEFAULTS`, `validateConfig`)
  - `src/contracts/outcome.ts` (`ClassificationKind`, `OracleReasonCode`, `OracleOutcome`, `GIT_BISECT_EXIT_CODES`, `SessionConclusion`)
  - `src/contracts/ledger.ts` (`LedgerEvent`, `LedgerEventInput`, `GENESIS_PREV_HASH`)
  - `src/contracts/session.ts` (`SessionState`, `ALLOWED_STATE_TRANSITIONS`, `isValidStateTransition`, `SessionManifestV1`)
  - `src/contracts/engine.ts` (`BisectEngine`, `FakeEngine`, `DoctorReport`, `BisectPlanReport`, `StartSessionOptions`, `CleanupOptions`)
  - `src/contracts/index.ts`
- **Scaffold Files Created:**
  - `package.json`, `package-lock.json`, `tsconfig.json`, `.nvmrc`, `.dockerignore`, `.env.example`, `Dockerfile`, `README.md`, `src/index.ts`, `tests/unit/contracts.test.ts`
- **Coexistence Note:** Preserved `pyproject.toml`, `src/bisectpilot/__init__.py`, `tests/test_bisectpilot.py`, `website/`, and `ai-agent-toolkit/` intact.
- **Next Handoff:** Implementing `A1`–`A10` in order on `agent-a/engine`. Agent B can build CLI commands and report generators against `FakeEngine` in `src/contracts/engine.ts`.
