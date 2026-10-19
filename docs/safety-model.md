# BisectPilot Safety Model

## 1. Original Checkout Preservation

- BisectPilot **never** runs `git bisect`, `git checkout`, `git reset`, or `git clean` in the user's primary working tree.
- Every investigation creates a dedicated detached worktree under `.bisectpilot/sessions/<id>/worktree` and writes a tool-ownership marker (`bisectpilot-owned.json`) inside that worktree's Git directory (`git rev-parse --git-path`).
- Destructive worktree reset (`resetOwnedWorktree`) and cleanup (`removeOwnedWorktree`) pass through a single mandatory guard (`verifyWorktreeOwnership`) that checks:
  1. `manifest.repository.createdByTool === true`
  2. Realpath inequality with the user's original repository root
  3. Realpath equality with `manifest.repository.worktreePath`
  4. `git rev-parse --git-common-dir` equality with `manifest.repository.commonGitDir`
  5. Integrity of the `bisectpilot-owned.json` marker matching `manifest.id`

## 2. Subprocess & Environment Isolation

- All external processes are launched via `child_process.spawn(executable, args, { shell: false })`.
- When launching `node` for the bisect runner or oracle, `process.execPath` is used so historical `.nvmrc` or `PATH` changes cannot hijack the runner runtime.
- On POSIX, child processes run in their own process group (`detached: true`); timeouts and cancellations send `SIGTERM` to `-pid` followed by `SIGKILL` after the grace window so grandchild processes do not leak.
- Only a minimal baseline environment plus deterministic defaults (`CI=1`, `TZ=UTC`, `LANG=C.UTF-8`, `NO_COLOR=1`, `FORCE_COLOR=0`) and explicitly allowlisted variable names are passed to child processes.

## 3. Classification Honesty & Exit-Code Safety

- Timeouts (`skip` -> `125`), missing executables (`abort` -> `128`), and prepare/build prerequisite failures (`skip` -> `125`) are **never** classified as `bad` (`1`).
- The bisect runner never emits exit codes `126` or `127`.

## 4. Important Limitation: Worktree != Sandbox

- A Git worktree isolates working files and `refs/bisect/*` state, **not** OS-level processes, filesystem outside the worktree, or network access.
- Executing historical builds or tests runs repository code with the invoking user's permissions. BisectPilot requires explicit consent (`confirmBeforeExecutingCode` / `--yes`) before running historical code. For untrusted or hostile repositories, run BisectPilot inside an isolated container or VM.
