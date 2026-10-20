# BisectPilot Configuration & Oracle Guide

## Configuration and Oracle Guide

BisectPilot validates configuration files strictly against `BisectConfigV1` (`src/contracts/config.ts`).

### Supported Oracle Modes (`oracle.mode`)

1. **`in-tree` (default):** Executes a test command that already exists inside the historical commits being bisected.
2. **`overlay`:** Copies one or more relative files (`oracle.overlayFiles`) from your current checkout into the detached worktree before testing each revision, then removes them afterward. Useful when you wrote a new regression test on `HEAD` that does not exist in older commits.
   - `oracle.overlayConflictPolicy`: Set to `"skip"` (default) or `"abort"` if a historical commit modifies a file in `overlayFiles`.
   - Overlay files are SHA-256 snapshotted at session start so mid-run edits in your working tree cannot corrupt the bisect.
3. **`external`:** Runs a script (`oracle.externalScriptPath`, a safe relative path inside the repository) snapshotted into the session directory before bisection begins.
4. **Interactive prompting (`execution.interactivePrompt: true` or `--prompt`):** Displays command output at each step and prompts a human operator to classify the commit (`good`, `bad`, `skip`, or `abort`), recording `"classifiedBy": "human"` in the ledger.
5. **Noisy/flaky oracle (`execution.noisyOracle.enabled: true` or `--noisy`):** Evaluates each commit up to `maxSamplesPerRevision` (default `5`) times using closed-form Bayesian posterior updates ($P(\text{bad}) = \frac{1}{1 + r^{\text{passes} - \text{fails}}}$) with `flakeRate` (default `0.10`) and early stopping at `confidenceThreshold` (default `0.90`).

### Optional Lifecycle Hooks & Toolchain Wrappers

- `prepare`: Optional `CommandSpec` (`command`, `args`, `timeoutMs`, `cwdRelative`) run before `build` and `oracle` (e.g., dependency installation). Failures classify the revision as `skip` (`125`), never `bad`.
- `build`: Optional `BuildCommandSpec` with `failurePolicy: "skip" | "abort"` (default `"skip"`). Broken historical builds are skipped rather than blamed as test regressions.
- `execution.toolchainWrapper`: Wraps commands in a version manager (for example, `{"command": "fnm", "args": ["exec", "--using=20"]}`) when historical commits require a specific runtime.

### Valid Configuration Example (Overlay + Prepare/Build)

```json
{
  "schemaVersion": 1,
  "profile": "functional",
  "repositoryRoot": ".",
  "workingDirectory": "packages/core",
  "goodRef": "v1.2.0",
  "badRef": "HEAD",
  "prepare": {
    "command": "npm",
    "args": ["ci", "--ignore-scripts"],
    "timeoutMs": 120000
  },
  "build": {
    "command": "npm",
    "args": ["run", "build"],
    "timeoutMs": 60000,
    "failurePolicy": "skip"
  },
  "oracle": {
    "mode": "overlay",
    "overlayFiles": ["packages/core/tests/regression-issue-42.test.js"],
    "overlayConflictPolicy": "skip",
    "command": {
      "command": "node",
      "args": ["--test", "packages/core/tests/regression-issue-42.test.js"],
      "timeoutMs": 30000
    }
  },
  "execution": {
    "maxOutputBytesPerCommand": 1000000,
    "maxRetries": 0,
    "endpointFlakeRuns": 3,
    "boundaryConfirmRuns": 3,
    "maxSkips": 10,
    "confirmBeforeExecutingCode": true,
    "cleanIgnored": false,
    "allowlistedEnvVars": ["NODE_OPTIONS"],
    "enforceNodeToolchainCheck": true,
    "interactivePrompt": false
  }
}
```

### Diagnosing Common Configuration Errors

Run `bisectpilot plan --config <file>` to validate configuration and repository state before starting a session. If validation fails, the CLI exits with code `2` and prints structured JSON validation issues (`[{"path": "...", "message": "..."}]`):

- **Path traversal rejected:** `workingDirectory`, `oracle.overlayFiles`, and `oracle.externalScriptPath` must stay inside `repositoryRoot` and cannot use `..` escapes or symlinks pointing outside the repo.
- **Invalid bisect terms:** `terms.old` and `terms.new` cannot be identical, contain whitespace/Git ref special characters, or use reserved Git bisect subcommands (`start`, `skip`, `reset`, `run`, `log`, `replay`, `view`, `visualize`, `help`, `terms`).
- **Sandbox policy errors:** `execution.sandbox.image` must match `<lowercase-repo>@sha256:<64-lowercase-hex>`. `interactivePrompt`, `envOverrides`, and secret-like `allowlistedEnvVars` (`TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `API_KEY`, `AWS_`, `GCP_`, `AZURE_`) are rejected when sandboxing is enabled.

---

