# ADR 0001: Phase G0 Frozen Contracts & Coexistence with Python/Web Surface

- **Date:** 2026-10-19
- **Status:** Accepted & Frozen (Phase G0)
- **Author:** Agent A (`agent-a/engine`)
- **Review Requested:** Agent B (`agent-b/experience`)

## 1. Context & Coexistence Investigation

The existing repository contains:
- `website/`: Next.js 16 interactive replay specimen (`/explorer`)
- `src/bisectpilot/__init__.py` & `pyproject.toml`: Zero-dependency Python JSONL trace diff helper
- Local agent tooling was present during the original scaffold, but is intentionally kept outside the product repository after the productionization cleanup.

Meanwhile, the BisectPilot v3 master blueprint (`bisectpilot-master-plan-v3.md`) specifies a **TypeScript/Node.js modular monolith** for the core Git regression bisection engine (`src/contracts/`, `src/adapters/`, `src/domain/`, `src/runner/`, `src/application/`).

## 2. Decision

1. **Preserve Existing Python & Website Assets Without Deletion:**
   - Keep `src/bisectpilot/__init__.py`, `pyproject.toml`, `tests/test_bisectpilot.py`, and `website/` intact.
   - Expose `npm run test:py` alongside `npm test` so both Python and TypeScript test suites remain runnable.
2. **Root TypeScript/Node.js ESM Scaffold:**
   - Use strict TypeScript (`NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`) compiling `src/**/*.ts` and `tests/**/*.ts` into `dist/` (gitignored).
   - Use Node's built-in `node --test` runner on compiled `dist/tests/**/*.test.js` files to keep runtime dependencies at zero and devDependencies minimal (`typescript`, `@types/node`).
3. **Freeze `src/contracts/` (Phase G0):**
   - `src/contracts/config.ts`: `BisectConfigV1`, `OracleSpec` (`in-tree` | `overlay` | `external`), `ExecutionPolicy`, `DETERMINISTIC_ENV_DEFAULTS`, and `validateConfig()`.
   - `src/contracts/outcome.ts`: `ClassificationKind` (`good` | `bad` | `skip` | `abort`), `OracleReasonCode`, `GIT_BISECT_EXIT_CODES` (`0`, `1`, `125`, `128` — never `126` or `127`), `SessionOutcomeKind`, and `SessionConclusion`.
   - `src/contracts/ledger.ts`: Hash-chained `LedgerEvent` union (`session_created`, `transition`, `process_starting`, `process_exited`, `revision_classified`, `boundary_check`, `cleanup_step`, `session_concluded`) with `schemaVersion: 1`, `prevHash`, and `eventHash`.
   - `src/contracts/session.ts`: Unified 14-state machine (`SessionState`), `ALLOWED_STATE_TRANSITIONS`, `isValidStateTransition()`, and `SessionManifestV1`.
   - `src/contracts/engine.ts`: `BisectEngine` interface (`doctor`, `plan`, `start`, `status`, `resume`, `cleanup`, `list`) and `FakeEngine`.

## 3. Consequences

- Agent B can immediately build CLI commands, reports, and fixture orchestration against `src/contracts/` and `FakeEngine`.
- Any subsequent change to `src/contracts/**` requires a joint note in `docs/handoff.md` and a new ADR in `docs/decisions/`.
