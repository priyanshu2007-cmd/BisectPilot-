/**
 * Frozen Contract: Hash-Chained Evidence Ledger Events (Phase G0)
 * Owner: Shared (Agent A + Agent B).
 */

import type { ClassificationKind, OracleReasonCode, SessionConclusion } from "./outcome.js";
import type { SessionState } from "./session.js";

export type StepPhase = "prepare" | "build" | "oracle" | "preflight_good" | "preflight_bad" | "boundary_check";

export interface LedgerEventBase {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly prevHash: string;
  readonly eventHash: string;
}

import type { BenchmarkSpec, SandboxResourceLimits, SandboxRuntime } from "./config.js";

export interface SandboxLedgerEvidence {
  readonly runtime: SandboxRuntime;
  readonly image: string;
  readonly network: "none";
  readonly rootlessVerified: boolean;
  readonly readOnlyRootFilesystem: boolean;
  readonly nonRootUser: boolean;
  readonly capabilitiesDropped: "ALL";
  readonly noNewPrivileges: boolean;
  readonly resources: SandboxResourceLimits;
  readonly containerId?: string;
  readonly ownerLabel?: string;
  readonly cleanup: "not_started" | "verified" | "failed";
  readonly terminationReason?: "timeout" | "cancel";
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export interface SessionCreatedEvent extends LedgerEventBase {
  readonly type: "session_created";
  readonly goodSha: string;
  readonly badSha: string;
  readonly worktreePath: string;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly terms?: {
    readonly old: string;
    readonly new: string;
  };
  readonly workingDirectory?: string;
  readonly pathScope?: readonly string[];
  readonly benchmark?: BenchmarkSpec;
}


export interface StateTransitionEvent extends LedgerEventBase {
  readonly type: "transition";
  readonly from: SessionState;
  readonly to: SessionState;
  readonly reason?: string;
}

export interface ProcessStartingEvent extends LedgerEventBase {
  readonly type: "process_starting";
  readonly commitSha: string;
  readonly phase: StepPhase;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sandboxRequested?: {
    readonly runtime: SandboxRuntime;
    readonly image: string;
    readonly network: "none";
    readonly resources: SandboxResourceLimits;
  };
}

export interface ProcessExitedEvent extends LedgerEventBase {
  readonly type: "process_exited";
  readonly commitSha: string;
  readonly phase: StepPhase;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly terminationSignalSent?: "SIGTERM" | "SIGKILL" | "taskkill";
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly sandbox?: SandboxLedgerEvidence;
}

export interface SandboxCreatedEvent extends LedgerEventBase {
  readonly type: "sandbox_created";
  readonly commitSha: string;
  readonly phase: StepPhase;
  readonly runtime: SandboxRuntime;
  readonly image: string;
  readonly containerId: string;
  readonly ownerLabel: string;
}

export interface RevisionClassifiedEvent extends LedgerEventBase {
  readonly type: "revision_classified";
  readonly commitSha: string;
  readonly classification: ClassificationKind;
  readonly reasonCode: OracleReasonCode;
  readonly detail: string;
  readonly gitExitCode: 0 | 1 | 125 | 128;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly classifiedBy?: "automated" | "human";
  readonly noisySampling?: {
    readonly sampleCount: number;
    readonly passedRuns: number;
    readonly failedRuns: number;
    readonly skippedRuns: number;
    readonly posterior: number;
    readonly confidenceThreshold: number;
  };
  readonly toolchainInfo?: {
    readonly detectedNodeSpec?: string;
    readonly runningNodeVersion: string;
    readonly packageManager?: string;
    readonly monorepoType?: string;
    readonly rootLockfileName?: string;
    readonly rootLockfileHash?: string;
    readonly rootManifestHash?: string;
    readonly workspaceManifestHash?: string;
    readonly workspaceRelPath?: string;
  };
  readonly benchmark?: {
    readonly metric: string;
    readonly unit?: string;
    readonly sampleCount: number;
    readonly warmupRuns: number;
    readonly mean: number;
    readonly variance: number;
    readonly stdDev: number;
    readonly median: number;
    readonly p95: number;
    readonly p99: number;
    readonly baselineMean?: number;
    readonly absoluteDelta?: number;
    readonly relativeDelta?: number;
    readonly tStatistic?: number;
    readonly degreesOfFreedom?: number;
    readonly pValue?: number;
    readonly alpha?: number;
    readonly isSignificant?: boolean;
    readonly isPracticalRegression?: boolean;
    readonly direction?: string;
    readonly decision?: string;
    readonly testName?: string;
  };
}


export interface BoundaryCheckEvent extends LedgerEventBase {
  readonly type: "boundary_check";
  readonly target: "good_endpoint" | "bad_endpoint" | "candidate" | "candidate_parent";
  readonly commitSha: string;
  readonly totalRuns: number;
  readonly passedRuns: number;
  readonly failedRuns: number;
  readonly skippedRuns: number;
  readonly abortedRuns: number;
}

export interface CleanupStepEvent extends LedgerEventBase {
  readonly type: "cleanup_step";
  readonly action: "worktree_reset" | "overlay_removed" | "worktree_removed" | "bisect_reset";
  readonly targetPath: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SessionConcludedEvent extends LedgerEventBase {
  readonly type: "session_concluded";
  readonly conclusion: SessionConclusion;
}

export type LedgerEvent =
  | SessionCreatedEvent
  | StateTransitionEvent
  | ProcessStartingEvent
  | ProcessExitedEvent
  | SandboxCreatedEvent
  | RevisionClassifiedEvent
  | BoundaryCheckEvent
  | CleanupStepEvent
  | SessionConcludedEvent;

export type LedgerEventInput =
  | Omit<SessionCreatedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<StateTransitionEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<ProcessStartingEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<ProcessExitedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<SandboxCreatedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<RevisionClassifiedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<BoundaryCheckEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<CleanupStepEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<SessionConcludedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">;

export const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
