import type { BisectConfigV1, SandboxRuntime } from "./config.js";
import type { SessionConclusion } from "./outcome.js";

export type JobType = "bisect" | "sample_evaluation" | "benchmark_sample";

export type JobState =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "retry_pending"
  | "needs_recovery";

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  queued: ["leased", "cancelled"],
  leased: ["running", "succeeded", "failed", "retry_pending", "needs_recovery", "cancel_requested"],
  running: ["succeeded", "failed", "cancel_requested", "needs_recovery"],
  succeeded: [],
  failed: [],
  cancel_requested: ["cancelled", "needs_recovery"],
  cancelled: [],
  retry_pending: ["leased", "cancelled"],
  needs_recovery: ["retry_pending", "cancelled"],
});

export function isValidJobTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface JobRepositoryRef {
  readonly strategy: "preprovisioned";
  readonly key: string;
  readonly expectedGoodSha: string;
  readonly expectedBadSha: string;
}

export interface BisectJobPayload {
  readonly config: BisectConfigV1;
  readonly repository: JobRepositoryRef;
}

export interface JobTransitionRecord {
  readonly at: string;
  readonly from: JobState;
  readonly to: JobState;
  readonly reason: string;
  readonly workerId?: string;
  readonly attempt: number;
}

export interface JobResult {
  readonly attempt: number;
  readonly fencingToken?: number;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly sessionId: string;
  readonly conclusion?: SessionConclusion;
  readonly detail?: string;
  readonly finishedAt: string;
  readonly sampleResult?: {
    readonly outcome: "good" | "bad" | "skip" | "inconclusive";
    readonly measurement?: number;
    readonly durationMs?: number;
  };
}

export interface JobRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly type: JobType;
  readonly protocolVersion: 1;
  readonly state: JobState;
  readonly fencingToken: number;
  readonly requiredCapabilities: {
    readonly jobTypes: readonly JobType[];
    readonly repositoryKey: string;
    readonly sandboxRuntime?: SandboxRuntime;
    readonly profile?: "functional" | "performance";
    readonly features?: readonly ("workspace" | "noisy" | "benchmark")[];
    readonly environmentIdentity?: {
      readonly platform: string;
      readonly architecture: string;
      readonly nodeVersion?: string;
    };
  };
  readonly payload: BisectJobPayload;
  readonly sampleMetadata?: {
    readonly parentJobId?: string;
    readonly sampleIndex: number;
    readonly revisionSha: string;
    readonly kind: "noisy_sample" | "benchmark_sample";
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempt: number;
  readonly assignedWorkerId?: string;
  readonly leaseExpiresAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly startedAt?: string;
  readonly cancelRequestedAt?: string;
  readonly recoveryReason?: string;
  readonly result?: JobResult;
  readonly transitions: readonly JobTransitionRecord[];
  readonly traceContext?: { readonly traceId: string; readonly spanId: string };
}

export interface QueueSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly jobs: readonly JobRecord[];
}

export interface WorkerCapabilities {
  readonly workerId: string;
  readonly protocolVersion: 1;
  readonly jobTypes: readonly JobType[];
  readonly repositoryKeys: readonly string[];
  readonly platform: string;
  readonly architecture: string;
  readonly maxConcurrentJobs: number;
  readonly sandboxRuntimes?: readonly SandboxRuntime[];
  readonly supportedProfiles?: readonly ("functional" | "performance")[];
  readonly features?: readonly ("workspace" | "noisy" | "benchmark")[];
  readonly environmentIdentity?: {
    readonly platform: string;
    readonly architecture: string;
    readonly nodeVersion?: string;
  };
}

export interface JobQueueSummary {
  readonly total: number;
  readonly queued: number;
  readonly leased: number;
  readonly running: number;
  readonly retryPending: number;
  readonly needsRecovery: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}
