/**
 * Frozen Contract: Session Manifest & Unified State Machine (Section 27, Phase G0)
 * Owner: Shared (Agent A + Agent B).
 */

import type { BisectConfigV1 } from "./config.js";
import type { SessionConclusion } from "./outcome.js";

export type SessionState =
  | "created"
  | "preflight_running"
  | "preflight_failed"
  | "awaiting_consent"
  | "worktree_ready"
  | "bisect_running"
  | "paused"
  | "boundary_verifying"
  | "concluded"
  | "cleanup_running"
  | "cleaned_up"
  | "cleanup_failed"
  | "cancel_requested"
  | "cancelled"
  | "needs_recovery";

export const TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "preflight_failed",
  "cleaned_up",
  "cleanup_failed",
  "cancelled",
]);

export const ALLOWED_STATE_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> =
  Object.freeze({
    created: ["preflight_running", "awaiting_consent", "worktree_ready", "cancel_requested", "needs_recovery"],
    preflight_running: [
      "preflight_failed",
      "awaiting_consent",
      "worktree_ready",
      "concluded",
      "cancel_requested",
      "needs_recovery",
    ],
    preflight_failed: ["cleanup_running", "cleaned_up"],
    awaiting_consent: ["worktree_ready", "preflight_running", "cancelled", "cancel_requested", "needs_recovery"],
    worktree_ready: ["preflight_running", "bisect_running", "cleanup_running", "cancel_requested", "needs_recovery"],
    bisect_running: [
      "paused",
      "boundary_verifying",
      "concluded",
      "cancel_requested",
      "needs_recovery",
    ],
    paused: ["bisect_running", "cleanup_running", "cancel_requested", "cancelled", "needs_recovery"],
    boundary_verifying: ["concluded", "cancel_requested", "needs_recovery"],
    concluded: ["cleanup_running", "cleaned_up"],
    cleanup_running: ["cleaned_up", "cleanup_failed"],
    cleaned_up: [],
    cleanup_failed: ["cleanup_running"],
    cancel_requested: ["cancelled", "cleanup_running", "cleaned_up"],
    cancelled: ["cleanup_running", "cleaned_up"],
    needs_recovery: ["bisect_running", "boundary_verifying", "cleanup_running", "cancel_requested", "cancelled"],
  });

export function isValidStateTransition(from: SessionState, to: SessionState): boolean {
  const allowed = ALLOWED_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export interface SessionRepositoryMetadata {
  readonly rootPath: string;
  readonly commonGitDir: string;
  readonly originalHead: string | null;
  readonly originalWasDirty: boolean;
  readonly worktreePath: string;
  readonly createdByTool: true;
}

export interface SessionBounds {
  readonly goodInputRef: string;
  readonly goodSha: string;
  readonly badInputRef: string;
  readonly badSha: string;
}

export interface SessionLockMetadata {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

import type { BenchmarkStats } from "../domain/benchmark.js";
import type { ClassificationKind, OracleReasonCode } from "./outcome.js";

export interface SessionManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: SessionState;
  readonly sessionDir: string;
  readonly ledgerPath: string;
  readonly repository: SessionRepositoryMetadata;
  readonly bounds: SessionBounds;
  readonly configHash: string;
  readonly config: BisectConfigV1;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly skipCount: number;
  readonly testedRevisions: readonly string[];
  readonly lastRecordedRevision?: string;
  readonly runnerVersion: string;
  readonly conclusion?: SessionConclusion;
  readonly benchmarkBaseline?: BenchmarkStats;
}

export interface ClassifiedRevisionRecord {
  readonly commitSha: string;
  readonly classification: ClassificationKind;
  readonly reasonCode: OracleReasonCode;
  readonly gitExitCode: 0 | 1 | 125 | 128;
  readonly detail: string;
  readonly durationMs?: number;
  readonly noisySampling?: {
    readonly sampleCount: number;
    readonly passedRuns: number;
    readonly failedRuns: number;
    readonly skippedRuns: number;
    readonly posterior: number;
    readonly confidenceThreshold: number;
  };
  readonly benchmark?: Record<string, unknown>;
  readonly classifiedAt: string;
}

export interface SessionCheckpointV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly checkpointSeq: number;
  readonly lastWalSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: SessionState;
  readonly searchPhase: "preflight" | "bisect" | "boundary_check" | "concluded";
  readonly repository: SessionRepositoryMetadata;
  readonly bounds: SessionBounds;
  readonly configHash: string;
  readonly config: BisectConfigV1;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly classifications: Readonly<Record<string, ClassifiedRevisionRecord>>;
  readonly testedRevisions: readonly string[];
  readonly skipCount: number;
  readonly lastRecordedRevision?: string;
  readonly conclusion?: SessionConclusion;
  readonly benchmarkBaseline?: BenchmarkStats;
  readonly checksum: string;
}
