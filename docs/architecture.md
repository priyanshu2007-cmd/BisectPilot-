# BisectPilot Microlithic Architecture

## 1. Architectural Overview

BisectPilot uses a **local-first microlithic architecture** (modular monolith) with strict boundaries between domain rules, infrastructure adapters, and application orchestration:

```text
BisectPilot/
├── src/
│   ├── contracts/      # Frozen shared types & schema validators (Phase G0)
│   ├── config/         # Config loading, hashing & deterministic env defaults
│   ├── domain/         # 4-kind classification rules, exit-code mapping & session state rules
│   ├── git/            # Git >= 2.36 inspection, ref resolution, ancestry & doctor checks
│   ├── worktree/       # Detached session worktree creation & guarded ownership verification
│   ├── process/        # Safe child_process execution (shell:false, process-group kill, output caps)
│   ├── oracle/         # in-tree, overlay (SHA-256 snapshotted), and external oracle execution
│   ├── ledger/         # Append-only hash-chained JSONL evidence ledger & chain verification
│   ├── session/        # Atomic manifest persistence, transitionSessionState() & lockfiles
│   ├── runner/         # External stable runner invoked by native `git bisect run`
│   ├── reports/        # Secret redaction, Markdown/JSON reports & repro.sh generator
│   ├── application/    # LocalBisectEngine orchestrating preflight, git bisect, boundary & recovery
│   ├── cli/            # Command-line dispatch (doctor, plan, start, status, report, cleanup, list)
│   └── bisectpilot/    # Preserved zero-dependency Python JSONL trace diff helper
├── tests/
│   ├── unit/           # Fast deterministic unit tests (contracts, git version, classifier, ledger)
│   ├── integration/    # Real temp-Git-repo integration tests (worktree safety, e2e git bisect)
│   └── test_bisectpilot.py # Preserved Python CLI unit test suite
└── website/            # Preserved Next.js 16 interactive replay specimen (/explorer)
```

## 2. Dependency Direction

- `contracts/` and `domain/` have **zero** dependencies on filesystem, Git, or child processes.
- `git/`, `worktree/`, `process/`, and `ledger/` depend only on Node.js stdlib and `contracts/`.
- `session/` and `oracle/` compose those low-level modules.
- `application/` (`LocalBisectEngine`) coordinates the end-to-end investigation workflow and implements `BisectEngine`.
