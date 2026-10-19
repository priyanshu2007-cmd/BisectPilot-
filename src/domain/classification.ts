import {
  mapClassificationToGitExitCode,
  type BuildCommandSpec,
  type ClassificationKind,
  type OracleOutcome,
  type OracleReasonCode,
  type RegressionProfile,
} from "../contracts/index.js";
import type { ProcessRunResult } from "../adapters/process/process-runner.js";

export function makeOutcome(
  kind: ClassificationKind,
  reasonCode: OracleReasonCode,
  detail: string
): OracleOutcome {
  return {
    kind,
    reasonCode,
    detail,
    gitExitCode: mapClassificationToGitExitCode(kind),
  };
}

export function classifyProcessInfrastructureError(
  result: ProcessRunResult,
  phaseLabel: "prepare" | "build" | "oracle"
): OracleOutcome | null {
  if (result.cancelled || result.terminatedBy === "cancel") {
    return makeOutcome("abort", "cancelled", `${phaseLabel} cancelled by user or signal`);
  }
  if (result.timedOut || result.terminatedBy === "timeout") {
    return makeOutcome(
      "skip",
      "timeout",
      `${phaseLabel} timed out after ${result.durationMs}ms`
    );
  }
  if (result.spawnErrorCode) {
    if (result.spawnErrorCode === "ENOENT") {
      return makeOutcome(
        "abort",
        "executable_not_found",
        `${phaseLabel} executable not found (${result.executable}): ${result.spawnErrorMessage ?? "ENOENT"}`
      );
    }
    if (result.spawnErrorCode === "EACCES" || result.spawnErrorCode === "EPERM") {
      return makeOutcome(
        "abort",
        "executable_not_permitted",
        `${phaseLabel} executable not permitted (${result.executable}): ${result.spawnErrorMessage ?? result.spawnErrorCode}`
      );
    }
    return makeOutcome(
      "abort",
      "spawn_error",
      `${phaseLabel} failed to spawn (${result.executable}): ${result.spawnErrorMessage ?? result.spawnErrorCode}`
    );
  }
  if (result.exitCode === 126) {
    return makeOutcome(
      "abort",
      "executable_not_permitted",
      `${phaseLabel} returned exit code 126 (command invoked cannot execute); refusing to pass 126 to git bisect`
    );
  }
  if (result.exitCode === 127) {
    return makeOutcome(
      "abort",
      "executable_not_found",
      `${phaseLabel} returned exit code 127 (command not found); refusing to pass 127 to git bisect`
    );
  }
  return null;
}

export function classifyPrepareStep(result: ProcessRunResult): OracleOutcome | null {
  const infra = classifyProcessInfrastructureError(result, "prepare");
  if (infra) return infra;
  if (result.exitCode === 0) return null;
  return makeOutcome(
    "skip",
    "prepare_failed",
    `Prepare step exited with status ${result.exitCode ?? "signal " + result.signal}`
  );
}

export function classifyBuildStep(
  result: ProcessRunResult,
  profile: RegressionProfile,
  buildSpec?: BuildCommandSpec
): OracleOutcome | null {
  const infra = classifyProcessInfrastructureError(result, "build");
  if (infra) return infra;
  if (result.exitCode === 0) return null;

  if (profile === "build") {
    return makeOutcome(
      "bad",
      "build_regression_failed",
      `Build failed with exit status ${result.exitCode} under build regression profile`
    );
  }

  const policy = buildSpec?.failurePolicy ?? "skip";
  if (policy === "abort") {
    return makeOutcome(
      "abort",
      "build_prerequisite_failed",
      `Build prerequisite failed with exit status ${result.exitCode} (failurePolicy=abort)`
    );
  }
  return makeOutcome(
    "skip",
    "build_prerequisite_failed",
    `Build prerequisite failed with exit status ${result.exitCode}; skipping untestable revision`
  );
}

export function classifyOracleStep(
  result: ProcessRunResult,
  profile: RegressionProfile
): OracleOutcome {
  const infra = classifyProcessInfrastructureError(result, "oracle");
  if (infra) return infra;

  if (result.exitCode === 125) {
    return makeOutcome("skip", "build_prerequisite_failed", "Oracle explicitly returned exit code 125 (skip)");
  }

  if (result.exitCode === 0) {
    return makeOutcome("good", "oracle_passed", "Oracle check passed (exit code 0)");
  }

  if (result.signal && result.exitCode === null) {
    return makeOutcome(
      "skip",
      "spawn_error",
      `Oracle terminated by signal ${result.signal} without exit code`
    );
  }

  return makeOutcome(
    "bad",
    profile === "build" ? "build_regression_failed" : "oracle_failed_expected_regression",
    `Oracle check failed with exit code ${result.exitCode}`
  );
}
