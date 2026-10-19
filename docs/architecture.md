# BisectPilot Microlithic Architecture

## 1. Architectural Overview

BisectPilot uses a **local-first microlithic architecture** (modular monolith) with strict boundaries between domain rules, infrastructure adapters, and application orchestration:

```text
BisectPilot/
├── src/
│   ├── contracts/      # Frozen shared types, schema validators & CustomBisectTerms/NoisyOraclePolicy
│   ├── config/         # Config loading, hashing, validation & deterministic env defaults
│   ├── domain/         # Classification rules, Bayesian math (closed-form posterior) & state machine
│   ├── git/            # Git >= 2.36 inspection, ref resolution, ancestry & doctor checks
│   ├── worktree/       # Detached session worktree creation & guarded ownership verification
│   ├── process/        # Safe child_process execution (shell:false, taskkill/POSIX kill, output caps)
│   ├── oracle/         # in-tree, overlay, and external oracle execution with multi-sample noisy mode
│   ├── ledger/         # Append-only hash-chained JSONL evidence ledger & chain verification
│   ├── session/        # Atomic manifest persistence, transitionSessionState() & lockfiles
│   ├── runner/         # External stable runner invoked by native `git bisect run`
│   ├── reports/        # Redaction, JSON/Markdown reports, replay-adapter & standalone repro.sh
│   ├── application/    # LocalBisectEngine orchestrating discovery, preflight, bisect, & recovery
│   ├── cli/            # Command-line dispatch (doctor, plan, start/run, status, report, cleanup, list)
│   └── bisectpilot/    # Preserved zero-dependency Python JSONL trace diff helper
├── tests/
│   ├── unit/           # Unit tests (contracts, cli, custom-terms, noisy-oracle, repro-script, prompt, wrapper)
│   ├── integration/    # Real temp-Git integration tests (auto-good-discovery, engine-bisect)
│   ├── fixtures/       # Reusable deterministic Git repository fixture builder & FakeEngine
│   ├── safety/         # Overlay conflict, toolchain mismatch, tracked mutation & cancellation tests
│   └── test_bisectpilot.py # Preserved Python CLI unit test suite
└── website/            # Next.js 16 interactive replay specimen (/explorer)
```

## 2. Dependency Direction

- `contracts/` and `domain/` have **zero** dependencies on filesystem, Git, or child processes.
- `git/`, `worktree/`, `process/`, and `ledger/` depend only on Node.js stdlib and `contracts/`.
- `session/` and `oracle/` compose those low-level modules.
- `application/` (`LocalBisectEngine`) coordinates the end-to-end investigation workflow and implements `BisectEngine`.
- Tests verify contracts against temporary Git repositories, isolated sub-processes, and simulated environments.
