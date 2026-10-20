/**
 * Frozen Contract: Classification Outcomes, Reason Codes, Session Outcomes & Exit Codes (Phase G0)
 * Owner: Shared (Agent A + Agent B).
 */

export type ClassificationKind = "good" | "bad" | "skip" | "abort";

import type { BenchmarkEvaluationResult, BenchmarkStats } from "../domain/benchmark.js";
export type { BenchmarkEvaluationResult, BenchmarkStats };

export type OracleReasonCode =
  | "oracle_passed"
  | "oracle_failed_expected_regression"
  | "build_regression_failed"
  | "prepare_failed"
  | "build_prerequisite_failed"
  | "timeout"
  | "cancelled"
  | "executable_not_found"
  | "executable_not_permitted"
  | "spawn_error"
  | "overlay_conflicts_with_tracked_file"
  | "overlay_missing_or_corrupt"
  | "toolchain_mismatch"
  | "worktree_not_clean"
  | "skip_budget_exceeded"
  | "untestable_revision"
  | "invalid_runner_config"
  | "benchmark_regression_detected"
  | "benchmark_within_tolerance"
  | "benchmark_insufficient_samples"
  | "benchmark_invalid_metric"
  | "benchmark_inconclusive"
  | "sandbox_runtime_unavailable"
  | "sandbox_policy_rejected"
  | "sandbox_image_unavailable"
  | "sandbox_cleanup_failed";

export interface OracleOutcome {
  readonly kind: ClassificationKind;
  readonly reasonCode: OracleReasonCode;
  readonly detail: string;
  readonly gitExitCode: GitBisectExitCode;
  readonly classifiedBy?: "automated" | "human";
  readonly noisySampling?: {
    readonly sampleCount: number;
    readonly passedRuns: number;
    readonly failedRuns: number;
    readonly skippedRuns: number;
    readonly posterior: number;
    readonly confidenceThreshold: number;
  };
  readonly benchmark?: BenchmarkEvaluationResult | BenchmarkStats;
}


/**
 * Native Git Bisect exit codes (Section 6.3 & 26.2).
 * NEVER emit 126 or 127 from the runner.
 */
export type GitBisectExitCode = 0 | 1 | 125 | 128;

export const GIT_BISECT_EXIT_CODES: Readonly<Record<ClassificationKind, GitBisectExitCode>> = Object.freeze({
  good: 0,
  bad: 1,
  skip: 125,
  abort: 128,
});

export function mapClassificationToGitExitCode(kind: ClassificationKind): GitBisectExitCode {
  const code = GIT_BISECT_EXIT_CODES[kind];
  if (code === undefined) {
    return 128;
  }
  return code;
}

export type SessionOutcomeKind =
  | "candidate_confirmed"
  | "candidate_unconfirmed"
  | "candidate_range"
  | "inconclusive"
  | "aborted";

export type InconclusiveReasonCode =
  | "skip_budget_exceeded"
  | "oracle_flaky_at_endpoints"
  | "endpoints_contradict"
  | "toolchain_mismatch_majority";

export interface SessionConclusion {
  readonly outcome: SessionOutcomeKind;
  readonly candidateSha?: string;
  readonly parentSha?: string;
  readonly candidateRangeShas?: readonly string[];
  readonly skippedShas: readonly string[];
  readonly inconclusiveReason?: InconclusiveReasonCode;
  readonly explanation: string;
}
