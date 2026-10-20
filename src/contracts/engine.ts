/**
 * Frozen Contract: BisectEngine Interface & FakeEngine (Section 28.1, Phase G0)
 * Owner: Shared (Agent A + Agent B).
 */

import type { BisectConfigV1 } from "./config.js";
import { GENESIS_PREV_HASH, type LedgerEvent } from "./ledger.js";
import type { SessionManifestV1 } from "./session.js";

export interface DoctorCheckResult {
  readonly id:
    | "git_version"
    | "git_repo"
    | "safe_directory"
    | "shallow_repository"
    | "active_bisect"
    | "git_lfs"
    | "submodules"
    | "sparse_checkout";
  readonly ok: boolean;
  readonly severity: "error" | "warning" | "info";
  readonly summary: string;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly gitVersion: string | null;
  readonly repoRoot: string | null;
  readonly commonGitDir: string | null;
  readonly checks: readonly DoctorCheckResult[];
}

export interface BisectPlanReport {
  readonly ok: boolean;
  readonly repoRoot: string;
  readonly goodSha: string;
  readonly badSha: string;
  readonly isLinearAncestor: boolean;
  readonly estimatedCommitsBetween: number;
  readonly estimatedSteps: number;
  readonly originalWasDirty: boolean;
  readonly warnings: readonly string[];
}

export interface StartSessionOptions {
  readonly sessionId?: string;
  readonly onEvent?: (event: LedgerEvent) => void;
  readonly confirm?: (plan: BisectPlanReport) => Promise<boolean> | boolean;
  readonly skipPreflight?: boolean;
  readonly autoCleanup?: boolean;
  readonly abortSignal?: AbortSignal;
}

export interface CleanupOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface CleanupResult {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly dryRun: boolean;
  readonly removedWorktree: boolean;
  readonly state: SessionManifestV1["state"];
  readonly detail: string;
}

export interface SessionStatusReport {
  readonly manifest: SessionManifestV1;
  readonly lockStatus: "unlocked" | "locked_live" | "locked_stale";
  readonly staleLockHolder?: {
    readonly pid: number;
    readonly hostname: string;
    readonly acquiredAt: string;
  };
  readonly eventCount: number;
  readonly ledgerValid: boolean;
  readonly checkpoint?: {
    readonly checkpointSeq: number;
    readonly lastWalSeq: number;
    readonly classifiedCount: number;
    readonly searchPhase: string;
    readonly resumable: boolean;
  };
}

export interface BisectEngine {
  doctor(repoPath?: string): Promise<DoctorReport>;
  plan(config: BisectConfigV1): Promise<BisectPlanReport>;
  start(config: BisectConfigV1, options?: StartSessionOptions): Promise<SessionManifestV1>;
  status(sessionId: string, sessionRootDir?: string, cwd?: string): Promise<SessionStatusReport>;
  resume(sessionId: string, options?: StartSessionOptions, sessionRootDir?: string, cwd?: string): Promise<SessionManifestV1>;
  cleanup(sessionId: string, options?: CleanupOptions, sessionRootDir?: string, cwd?: string): Promise<CleanupResult>;
  list(sessionRootDir?: string, cwd?: string): Promise<readonly SessionManifestV1[]>;
}

/**
 * Re-exported for backward compatibility with existing contract consumers.
 */
export { FakeEngine } from "./fake-engine.js";
