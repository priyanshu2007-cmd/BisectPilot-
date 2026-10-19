# SPEC: BisectPilot CLI & Explorer Trace Integration (v1)

## 1. Objective & Scope
Build the zero-dependency Python CLI (`src/bisectpilot/__init__.py`) and connect its exported JSON scenarios to the `/explorer` interactive UI (`website/components/PilotConsole.tsx`).

**In Scope (v1)**:
- `bisectpilot diff <baseline.jsonl> <current.jsonl> [--id ID] [--title TITLE] [--export-web] [--raw]`
- `bisectpilot bisect <base>..<curr> [--turn ID] [--export-web] [--raw]` (matches the command copied by `PilotConsole.tsx`)
- Canonical JSONL turn comparison + `(kind, label)` lookahead alignment (+1/+2)
- First-drift classification (`clean` | `drift` | `breach`) and `Scenario` JSON output matching `website/app/data/scenarios.ts`
- Dual-mode `/explorer` loading: auto-fetch `website/public/runs/index.json` + local `.json` scenario file upload (2 MB cap, runtime `isValidScenario()` guard)

**Out of Scope (v1)**:
- Live LLM re-execution or external API keys
- Third-party Python runtime dependencies (`pyproject.toml` dependencies = `[]`)
- Multi-file Python package structure (keep single-file `src/bisectpilot/__init__.py`)

## 2. CLI Contract & Normalization
1. **Input**: Two `.jsonl` trace files (`baseline`, `current`). Each line is a JSON object with at least `kind` (`system` | `user` | `assistant` | `tool` | `memory` | `guard`), `label`, and `text` (or `baseline`/`candidate` content).
2. **Canonicalization** (unless `--raw`):
   - Recursively sort JSON object keys.
   - Replace ISO-8601 timestamps and UUIDv4 strings with `<TS>` / `<UUID>` before diffing.
3. **Turn Alignment**:
   - Pair turns by index `i`, with +1/+2 lookahead on `(kind, label)` so a single inserted retry/tool turn is marked `drift` without misaligning subsequent turns.
4. **Status Classification**:
   - `clean`: canonical baseline == canonical candidate.
   - `breach`: first turn where `breach: true`, `guard` fails, or tool schema/policy violation occurs; otherwise the first `drift` turn if no explicit breach flag is present.
   - `drift`: any canonical mismatch prior to or after the breach turn.
   - Similarity ratio computed on `[:4096]` slice via `difflib.SequenceMatcher` (`# ponytail: 4KB slice for SequenceMatcher ratio; switch to line-hash diff if >4KB traces need exact ratios`).
5. **Safe Web Export (`--export-web`)**:
   - Sanitize `--id` with `re.sub(r"[^a-zA-Z0-9_-]", "-", raw_id)`.
   - Write `website/public/runs/<id>.json` and update `website/public/runs/index.json` atomically via `.tmp` + `os.replace()`.

## 3. UI Contract (`website/components/PilotConsole.tsx`)
1. On mount, fetch `/runs/index.json` (if present) and merge exported scenarios with built-in `SCENARIOS`.
2. Provide an **"Import JSON"** file input accepting `.json` up to `2 MB`.
3. Validate uploaded/fetched objects with `isValidScenario(obj)` (`id`, `title`, `firstDriftTurn`, non-empty `turns` array with valid `status`), auto-select `firstDriftTurn`, and announce status via `aria-live="polite"`.

## 4. Verification Criteria
- `python3 -m unittest discover -s tests -v` passes all CLI normalization, lookahead alignment, and atomic export tests.
- `cd website && npm test && npm run build` passes cleanly.
