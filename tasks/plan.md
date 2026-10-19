# Implementation Plan: BisectPilot CLI & Explorer Integration

> **Spec**: [SPEC.md](file:///Users/priyanshu/Documents/BisectPilot/SPEC.md)

## Tasks

### Task 1: Remove unused dependency from `pyproject.toml`
- **Files**: `pyproject.toml`
- **Change**: Set `dependencies = []` (remove unused `browser-use>=0.13.11`) and verify `[project.scripts] bisectpilot = "bisectpilot:main"`.
- **Verify**: `python3 -c "import tomllib, pathlib; d = tomllib.loads(pathlib.Path('pyproject.toml').read_text()); assert d['project']['dependencies'] == []"`

### Task 2: TDD — Write unit tests for `bisectpilot` CLI & bisection engine
- **Files**: `tests/test_bisectpilot.py`
- **Tests**:
  1. Canonical normalization strips volatile UUIDs/timestamps unless `--raw`.
  2. Lookahead (+1/+2) turn alignment handles an inserted tool retry turn without cascading false drift.
  3. `bisectpilot diff` and `bisectpilot bisect <base>..<curr> --turn T04` output valid `Scenario` JSON matching `website/app/data/scenarios.ts`.
  4. `--export-web` sanitizes `--id` against path traversal and atomically writes `<id>.json` + `index.json`.
- **Verify**: `PYTHONPATH=src python3 -m unittest discover -s tests -v`

### Task 3: Implement `src/bisectpilot/__init__.py` (stdlib only)
- **Files**: `src/bisectpilot/__init__.py`
- **Change**: Implement `canonicalize()`, `align_turns()`, `bisect_traces()`, `export_web_run()`, and `main()` supporting `diff` and `bisect` subcommands (~120 LOC stdlib Python).
- **Verify**: `PYTHONPATH=src python3 -m unittest discover -s tests -v`

### Task 4: Connect `/explorer` (`website/components/PilotConsole.tsx`) to exported & uploaded runs
- **Files**: `website/components/PilotConsole.tsx`
- **Change**:
  - Add `isValidScenario()` runtime type guard.
  - Fetch `/runs/index.json` on mount (silent fallback if absent).
  - Add `.json` upload button (`<= 2 MB` check, sets scenario + `firstDriftTurn`, announces via `aria-live="polite"`).
- **Verify**: `cd website && npm test && npm run build`
