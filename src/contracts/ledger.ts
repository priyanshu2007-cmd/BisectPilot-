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
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
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
  | RevisionClassifiedEvent
  | BoundaryCheckEvent
  | CleanupStepEvent
  | SessionConcludedEvent;

export type LedgerEventInput =
  | Omit<SessionCreatedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<StateTransitionEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<ProcessStartingEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<ProcessExitedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<RevisionClassifiedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<BoundaryCheckEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<CleanupStepEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">
  | Omit<SessionConcludedEvent, "schemaVersion" | "seq" | "timestamp" | "prevHash" | "eventHash">;

export const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
