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

## 4. Opt-In Rootless Sandbox

- Direct execution remains the default. `execution.sandbox` is required before any Docker/Podman invocation; there is no automatic image pull and no unsandboxed fallback when sandbox preflight fails.
- Sandbox preflight requires a local runtime endpoint, a structured rootless attestation, a locally available lowercase digest-pinned image, a non-root POSIX caller, and valid bounded resources. Remote Docker/Podman endpoints, runtime-socket mounts, writable extra mounts, reserved container targets, path traversal, symlink escapes, and persisted sandbox environment overrides are rejected.
- The container boundary uses `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, numeric non-root uid/gid, CPU/memory/PID/tmpfs limits, a cleared image entrypoint, and only the worktree plus approved read-only session inputs. The worktree is intentionally writable so historical builds can produce artifacts; it is still a tool-owned detached worktree, never the user's primary checkout.
- A created container must pass an ownership and restriction inspection before it starts. The ID and owner label are written to the hash-chained ledger immediately after creation. Cleanup stops (then kills if necessary) and removes only an ownership-matching container; an ownership mismatch or cleanup failure aborts closed and never triggers broad label/PID cleanup.
- Runtime output is bounded at the process boundary, while full observed stream hashes/byte counts and truncation flags remain available for evidence. Cancellation and timeout are classified before ordinary runtime/image/policy failures; cleanup failure takes precedence because it leaves an explicit safety uncertainty.

## 5. Important Limitation: Worktree != Sandbox

- A Git worktree isolates working files and `refs/bisect/*` state, **not** OS-level processes, filesystem outside the worktree, or network access.
- Executing historical builds or tests runs repository code with the invoking user's permissions. BisectPilot requires explicit consent (`confirmBeforeExecutingCode` / `--yes`) before running historical code. For untrusted or hostile repositories, run BisectPilot inside an isolated container or VM.

## 6. Daemon & Worker Boundaries

- Daemon state and queue files use atomic sibling-write plus rename. Queue files contain validated configs and transition history, never bearer-token values or `execution.envOverrides`.
- Daemon HTTP binds to loopback unless HTTPS is explicitly configured. Every protocol route except minimal `/health` requires a bearer token from a protected file. Fixed-length token comparisons use constant-time comparison; tokens are never logged.
- Workers initiate outbound polling. Remote workers use HTTPS and a pre-provisioned repository key mapped to a local absolute path. The worker verifies Git refs and rejects repository-path escapes, absolute oracle paths and symlink escapes before execution.
- Lease expiry before the first heartbeat may retry. Started or ambiguous work becomes `needs_recovery`; daemon shutdown never marks it successful or deletes its session worktree.
- Remote-machine, Windows and TLS deployment behavior is not claimed by local loopback tests; use a trusted certificate and test each target platform before production use.

## 7. Mutual TLS & Remote Worker Security Boundaries (Step 11)

- Bidirectional certificate verification is strictly enforced (`rejectUnauthorized: true`). Mismatched server hostnames, untrusted CAs, expired certificates, or missing client certificates are rejected at the TLS handshake.
- Non-loopback daemon binds refuse plain HTTP and require server certificate, private key, and trusted client CA material. Remote workers refuse plain HTTP URLs.
- Private keys and token files require POSIX `0o600` permissions (read/write only by owner); insecure permissions fail startup immediately.
- Client Subject Common Name (`CN`) must match the claimed `workerId`. Workers cannot claim or impersonate identities other than what their client certificate asserts.
- Peer certificate SHA-256 fingerprints are checked on every request over active TLS connections against an in-memory and disk-persisted revocation list (`revocations.json`), terminating compromised worker access immediately.
- Workers cannot claim or submit results for jobs assigned to other workers; lease ownership, attempt count, and worker identity must strictly match active job leases.
- In-place dynamic context rotation (`setSecureContext`) validates replacement keys and certificates prior to application, preventing invalid configuration files from crashing running daemons or workers.

## Session Recovery Guarantees (Step 14)

- Checkpoints are written via temp file + atomic rename; a torn write fails checksum validation and never replaces the last good copy.
- Corrupt primary falls back to the backup, then to ledger reconstruction. A broken ledger hash chain aborts reconstruction instead of producing an empty session.
- Cached classifications are reused only for exact commit SHAs recorded by an accepted ledger event; a previously executed command is not treated as a classification.
- Resume verifies worktree ownership, config hash and overlay hashes; mismatches stop with an error rather than altering good/bad bounds.
- Daemon restart never auto-resumes or marks interrupted sessions successful.
- **Not guaranteed:** survival of power loss or storage failure (no explicit fsync of checkpoint data/directory).
