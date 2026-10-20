import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type {
  BisectConfigV1,
  CommandSpec,
  LedgerEvent,
  OracleOutcome,
  StepPhase,
} from "../contracts/index.js";
import {
  classifyBuildStep,
  classifyOracleStep,
  classifyPrepareStep,
  classifyProcessInfrastructureError,
  makeOutcome,
} from "../domain/classification.js";
import { evaluateBayesianDecision } from "../domain/bayesian.js";
import { detectWorkspaceDependencies } from "../domain/workspace.js";
import {
  parseBenchmarkMetric,
  buildBenchmarkStats,
  evaluateBenchmarkRegression,
  type BenchmarkStats,
  type BenchmarkEvaluationResult,
} from "../domain/benchmark.js";
import { appendLedgerEvent } from "../ledger/index.js";
import {
  applyToolchainWrapper,
  runSafeProcess,
  type ProcessRunResult,
  type SandboxMetadata,
  type SandboxMount,
  type SandboxRuntimeExecutor,
} from "../process/index.js";
import { defaultMetrics, getTracer } from "../telemetry/index.js";
import { inspectRevisionToolchain } from "./toolchain.js";
import { isPathTrackedInRevision, sha256File } from "./overlay.js";
import { promptHumanClassification, type PromptStreams } from "./interactive.js";

export interface RevisionEvaluationParams {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly ledgerPath: string;
  readonly worktreePath: string;
  readonly commitSha: string;
  readonly config: BisectConfigV1;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly phasePrefix?: "oracle" | "preflight_good" | "preflight_bad" | "boundary_check";
  readonly promptStreams?: PromptStreams;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
  readonly benchmarkBaseline?: BenchmarkStats;
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
}

async function runAndRecordStep(params: {
  readonly sessionId: string;
  readonly ledgerPath: string;
  readonly commitSha: string;
  readonly phase: StepPhase;
  readonly commandSpec: CommandSpec;
  readonly cwd: string;
  readonly config: BisectConfigV1;
  readonly workspaceRoot: string;
  readonly sessionDir: string;
  readonly detectedToolchainVersion?: string;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
}): Promise<ProcessRunResult> {
  const wrapped = applyToolchainWrapper(
    params.commandSpec,
    params.config.execution.toolchainWrapper,
    params.detectedToolchainVersion
  );

  const sandboxMounts: SandboxMount[] = [];
  if (params.config.execution.sandbox && params.config.oracle.mode === "external" && params.config.oracle.externalScriptPath) {
    const externalSnapshot = path.join(params.sessionDir, "external", path.basename(params.config.oracle.externalScriptPath));
    if (existsSync(externalSnapshot)) {
      sandboxMounts.push({
        hostPath: externalSnapshot,
        containerPath: `/bisectpilot-input/${path.basename(externalSnapshot)}`,
        readOnly: true,
      });
    }
  }

  appendLedgerEvent(
    params.ledgerPath,
    {
      type: "process_starting",
      sessionId: params.sessionId,
      commitSha: params.commitSha,
      phase: params.phase,
      command: wrapped.command,
      args: wrapped.args,
      cwd: params.cwd,
      ...(params.config.execution.sandbox
        ? {
            sandboxRequested: {
              runtime: params.config.execution.sandbox.runtime,
              image: params.config.execution.sandbox.image,
              network: params.config.execution.sandbox.network,
              resources: params.config.execution.sandbox.resources,
            },
          }
        : {}),
    },
    params.onEvent
  );

  const result = await runSafeProcess({
    commandSpec: params.commandSpec,
    cwd: params.cwd,
    executionPolicy: params.config.execution,
    workspaceRoot: params.workspaceRoot,
    sandboxMounts,
    sandboxAllowedReadOnlyRoots: [params.sessionDir],
    sandboxOwnerId: `${params.sessionId}-${params.commitSha.slice(0, 12)}-${params.phase}`,
    sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
    sandboxOnContainerCreated: async (metadata: SandboxMetadata) => {
      if (!metadata.containerId || !metadata.ownerLabel) return;
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "sandbox_created",
          sessionId: params.sessionId,
          commitSha: params.commitSha,
          phase: params.phase,
          runtime: metadata.runtime,
          image: metadata.image,
          containerId: metadata.containerId,
          ownerLabel: metadata.ownerLabel,
        },
        params.onEvent
      );
    },
    detectedToolchainVersion: params.detectedToolchainVersion,
    abortSignal: params.abortSignal,
  });

  appendLedgerEvent(
    params.ledgerPath,
    {
      type: "process_exited",
      sessionId: params.sessionId,
      commitSha: params.commitSha,
      phase: params.phase,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncatedStdout: result.truncatedStdout,
      truncatedStderr: result.truncatedStderr,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      ...(result.stdoutBytes !== undefined ? { stdoutBytes: result.stdoutBytes } : {}),
      ...(result.stderrBytes !== undefined ? { stderrBytes: result.stderrBytes } : {}),
      ...(result.terminationSignalSent ? { terminationSignalSent: result.terminationSignalSent } : {}),
      stdoutPreview: result.stdout.slice(0, 512),
      stderrPreview: result.stderr.slice(0, 512),
      ...(result.sandbox
        ? {
              sandbox: {
                ...result.sandbox,
                ...(result.sandboxFailureCode ? { failureCode: result.sandboxFailureCode } : {}),
                ...(result.sandboxFailureMessage ? { failureMessage: result.sandboxFailureMessage } : {}),
              },
          }
        : {}),
    },
    params.onEvent
  );
  if (result.timedOut) {
    defaultMetrics.processTimeoutsTotal.inc({ phase: params.phase });
  }
  if (result.cancelled) {
    defaultMetrics.cancellationsTotal.inc({ scope: "process" });
  }
  if (result.spawnErrorMessage || (result.exitCode !== null && result.exitCode !== 0 && params.phase !== "oracle")) {
    defaultMetrics.processFailuresTotal.inc({ phase: params.phase });
  }
  if (result.sandbox) {
    defaultMetrics.containerExecutionDurationSeconds.observe({ runtime: result.sandbox.runtime }, result.durationMs / 1000);
  }

  return result;
}

function recordClassificationTelemetry(
  mode: string,
  outcome: OracleOutcome,
  durationSec: number,
  benchmark?: unknown
): void {
  defaultMetrics.revisionsEvaluatedTotal.inc({ classification: outcome.kind });
  const classificationLabel = outcome.kind === "good" ? "good" : outcome.kind === "bad" ? "bad" : outcome.kind === "skip" ? "skipped" : "inconclusive";
  defaultMetrics.bisectionClassificationsTotal.inc({ classification: classificationLabel });
  defaultMetrics.oracleExecutionDurationSeconds.observe({ mode }, durationSec);
  if (benchmark && typeof benchmark === "object" && "decision" in benchmark) {
    const b = benchmark as BenchmarkEvaluationResult;
    defaultMetrics.benchmarkSamplesTotal.inc({ metric: b.candidate?.metric || "unknown" }, b.candidate?.count ?? 1);
  }
}

/**
 * Evaluates a single checked-out revision in the tool-owned worktree (A4 + A5 + A6).
 * Guarantees overlay file removal in a `finally` block even on timeout or crash.
 */
export async function evaluateCheckedOutRevision(
  params: RevisionEvaluationParams
): Promise<OracleOutcome> {
  const startTime = Date.now();
  const tracer = getTracer("bisectpilot.oracle");

  return tracer.withSpan(
    "oracle.evaluate_revision",
    async (span) => {
      span.setAttribute("session.id", params.sessionId);
      span.setAttribute("commit.sha", params.commitSha);
      span.setAttribute("oracle.mode", params.config.oracle.mode);
      if (params.phasePrefix) {
        span.setAttribute("phase", params.phasePrefix);
      }

      const stepCwd = path.resolve(params.worktreePath, params.config.workingDirectory || ".");
      if (!existsSync(stepCwd)) {
        const outcome = makeOutcome(
          "skip",
          "untestable_revision",
          `Workspace directory "${params.config.workingDirectory}" does not exist at revision ${params.commitSha.slice(0, 7)}`
        );
        appendLedgerEvent(
          params.ledgerPath,
          {
            type: "revision_classified",
            sessionId: params.sessionId,
            commitSha: params.commitSha,
            classification: outcome.kind,
            reasonCode: outcome.reasonCode,
            detail: outcome.detail,
            gitExitCode: outcome.gitExitCode,
            overlayHashes: params.overlayHashes,
            classifiedBy: "automated",
          },
          params.onEvent
        );
        recordClassificationTelemetry(params.config.oracle.mode, outcome, Math.max(0, (Date.now() - startTime) / 1000));
        return outcome;
      }

  const toolchain = inspectRevisionToolchain(params.worktreePath);
  const wsDeps = detectWorkspaceDependencies(params.worktreePath, params.config.workingDirectory || ".");
  const toolchainInfoRecord = {
    ...(toolchain.detectedNodeSpec ? { detectedNodeSpec: toolchain.detectedNodeSpec } : {}),
    runningNodeVersion: toolchain.runningNodeVersion,
    packageManager: wsDeps.packageManager !== "unknown" ? wsDeps.packageManager : toolchain.packageManager,
    ...(wsDeps.monorepoType !== "none" ? { monorepoType: wsDeps.monorepoType } : {}),
    ...(wsDeps.rootLockfileName ? { rootLockfileName: wsDeps.rootLockfileName } : {}),
    ...(wsDeps.rootLockfileHash ? { rootLockfileHash: wsDeps.rootLockfileHash } : {}),
    ...(wsDeps.rootManifestHash ? { rootManifestHash: wsDeps.rootManifestHash } : {}),
    ...(wsDeps.workspaceManifestHash ? { workspaceManifestHash: wsDeps.workspaceManifestHash } : {}),
    workspaceRelPath: wsDeps.workspaceRelPath,
  };
  const detectedVersion =
    toolchain.detectedNodeSpec ??
    (toolchain.requiredMajor !== undefined ? String(toolchain.requiredMajor) : undefined);
  const wrapper = params.config.execution.toolchainWrapper;

  if (wrapper) {
    const rawArgs = wrapper.args ?? [];
    const requiresVersion = rawArgs.some(
      (arg) => arg.includes("<version>") || arg.includes("${version}")
    );
    if (requiresVersion && !detectedVersion) {
      let outcome = makeOutcome(
        "skip",
        "toolchain_mismatch",
        `Toolchain wrapper (${wrapper.command}) requires a detected runtime version (<version>), but none was found in the revision`
      );
      if (
        params.config.execution.interactivePrompt === true &&
        (params.phasePrefix === "oracle" || params.phasePrefix === undefined)
      ) {
        outcome = await promptHumanClassification({
          commitSha: params.commitSha,
          commandSpec: params.config.oracle.command,
          automatedOutcome: outcome,
          executionInfo: `Toolchain wrapper requires version but none found in revision`,
          streams: params.promptStreams,
          abortSignal: params.abortSignal,
        });
      }
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "revision_classified",
          sessionId: params.sessionId,
          commitSha: params.commitSha,
          classification: outcome.kind,
          reasonCode: outcome.reasonCode,
          detail: outcome.detail,
          gitExitCode: outcome.gitExitCode,
          overlayHashes: params.overlayHashes,
          classifiedBy: outcome.classifiedBy ?? "automated",
          toolchainInfo: toolchainInfoRecord,
        },
        params.onEvent
      );
      recordClassificationTelemetry(params.config.oracle.mode, outcome, Math.max(0, (Date.now() - startTime) / 1000));
      return outcome;
    }
  } else if (params.config.execution.enforceNodeToolchainCheck !== false && toolchain.mismatch) {
    let outcome = makeOutcome(
      "skip",
      "toolchain_mismatch",
      `Revision requires Node ${toolchain.detectedNodeSpec} (major ${toolchain.requiredMajor}), running ${toolchain.runningNodeVersion}`
    );
    if (
      params.config.execution.interactivePrompt === true &&
      (params.phasePrefix === "oracle" || params.phasePrefix === undefined)
    ) {
      outcome = await promptHumanClassification({
        commitSha: params.commitSha,
        commandSpec: params.config.oracle.command,
        automatedOutcome: outcome,
        executionInfo: `Toolchain mismatch: requires Node ${toolchain.detectedNodeSpec}, running ${toolchain.runningNodeVersion}`,
        streams: params.promptStreams,
        abortSignal: params.abortSignal,
      });
    }
    appendLedgerEvent(
      params.ledgerPath,
      {
        type: "revision_classified",
        sessionId: params.sessionId,
        commitSha: params.commitSha,
        classification: outcome.kind,
        reasonCode: outcome.reasonCode,
        detail: outcome.detail,
        gitExitCode: outcome.gitExitCode,
        overlayHashes: params.overlayHashes,
        classifiedBy: outcome.classifiedBy ?? "automated",
        toolchainInfo: toolchainInfoRecord,
      },
      params.onEvent
    );
    recordClassificationTelemetry(params.config.oracle.mode, outcome, Math.max(0, (Date.now() - startTime) / 1000));
    return outcome;
  }

  const copiedOverlayTargets: string[] = [];
  let finalOutcome: OracleOutcome | undefined;

  try {
    if (params.config.oracle.mode === "overlay") {
      const overlayFiles = params.config.oracle.overlayFiles ?? [];
      const snapshotDir = path.join(params.sessionDir, "overlays");

      for (const relPath of overlayFiles) {
        const normalizedRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
        const snapFile = path.resolve(snapshotDir, normalizedRel);
        if (!existsSync(snapFile)) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Missing snapshotted overlay file: ${snapFile}`
          );
          return finalOutcome;
        }
        const actualHash = sha256File(snapFile);
        const expectedHash = params.overlayHashes[normalizedRel];
        if (expectedHash && actualHash !== expectedHash) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Overlay SHA-256 mismatch for ${normalizedRel}`
          );
          return finalOutcome;
        }

        if (await isPathTrackedInRevision(params.worktreePath, normalizedRel)) {
          const policy = params.config.oracle.overlayConflictPolicy ?? "skip";
          finalOutcome = makeOutcome(
            policy,
            "overlay_conflicts_with_tracked_file",
            `Overlay file "${normalizedRel}" conflicts with a tracked file at commit ${params.commitSha.slice(0, 8)}`
          );
          return finalOutcome;
        }

        const destPath = path.resolve(params.worktreePath, normalizedRel);
        mkdirSync(path.dirname(destPath), { recursive: true });
        copyFileSync(snapFile, destPath);
        copiedOverlayTargets.push(destPath);
      }
    }

    let lastRunResult: ProcessRunResult | undefined;

    if (params.config.prepare) {
      const prepRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "prepare",
        commandSpec: params.config.prepare,
        cwd: stepCwd,
        config: params.config,
        workspaceRoot: params.worktreePath,
        sessionDir: params.sessionDir,
        detectedToolchainVersion: detectedVersion,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
        sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
      });
      lastRunResult = prepRes;
      const prepClassification = classifyPrepareStep(prepRes);
      if (prepClassification) {
        finalOutcome = prepClassification;
      }
    }

    if (!finalOutcome && params.config.build) {
      const buildRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "build",
        commandSpec: params.config.build,
        cwd: stepCwd,
        config: params.config,
        workspaceRoot: params.worktreePath,
        sessionDir: params.sessionDir,
        detectedToolchainVersion: detectedVersion,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
        sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
      });
      lastRunResult = buildRes;
      const buildClassification = classifyBuildStep(
        buildRes,
        params.config.profile,
        params.config.build
      );
      if (buildClassification) {
        finalOutcome = buildClassification;
      }
    }

    const oraclePhase: StepPhase = params.phasePrefix ?? "oracle";
    let oracleCommandSpec = params.config.oracle.command;

    if (!finalOutcome) {
      if (params.config.oracle.mode === "external" && params.config.oracle.externalScriptPath) {
        const extSnap = path.join(
          params.sessionDir,
          "external",
          path.basename(params.config.oracle.externalScriptPath)
        );
        if (!existsSync(extSnap)) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Missing snapshotted external script: ${extSnap}`
          );
          return finalOutcome;
        }
        const rawExt = params.config.oracle.externalScriptPath;
        oracleCommandSpec = {
          ...oracleCommandSpec,
          command: oracleCommandSpec.command === rawExt ? extSnap : oracleCommandSpec.command,
          args: oracleCommandSpec.args.map((arg) => (arg === rawExt ? extSnap : arg)),
        };
      }

      const noisyPolicy = params.config.execution.noisyOracle;

      if (params.config.profile === "performance" && params.config.benchmark) {
        const benchmarkConfig = params.config.benchmark;
        const warmupRuns = benchmarkConfig.warmup ?? 1;
        const minSamples = benchmarkConfig.minSamples ?? 3;
        const maxSamples = benchmarkConfig.maxSamples ?? 10;

        // 1. Warm-up runs (discard measurements)
        let warmupFailedOutcome: OracleOutcome | null = null;
        for (let w = 0; w < warmupRuns; w++) {
          if (params.abortSignal?.aborted) {
            finalOutcome = makeOutcome("abort", "cancelled", "Cancelled during benchmark warmup");
            break;
          }
          const warmupRes = await runAndRecordStep({
            sessionId: params.sessionId,
            ledgerPath: params.ledgerPath,
            commitSha: params.commitSha,
            phase: oraclePhase,
            commandSpec: oracleCommandSpec,
            cwd: stepCwd,
            config: params.config,
            workspaceRoot: params.worktreePath,
            sessionDir: params.sessionDir,
            detectedToolchainVersion: detectedVersion,
            abortSignal: params.abortSignal,
            onEvent: params.onEvent,
            sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
          });
          lastRunResult = warmupRes;
          const infra = classifyProcessInfrastructureError(warmupRes, "oracle");
          if (infra) {
            warmupFailedOutcome = infra;
            break;
          }
        }

        if (warmupFailedOutcome) {
          finalOutcome = warmupFailedOutcome;
        } else if (!finalOutcome) {
          // 2. Measurement sample collection
          const validSamples: number[] = [];
          let parseErrors = 0;
          let lastParseError = "";

          // Resolve baseline: from parameters or session manifest
          let baseline = params.benchmarkBaseline;
          if (!baseline && existsSync(path.join(params.sessionDir, "session.json"))) {
            try {
              const manifest = JSON.parse(readFileSync(path.join(params.sessionDir, "session.json"), "utf-8")) as {
                benchmarkBaseline?: BenchmarkStats;
              };
              if (manifest.benchmarkBaseline) {
                baseline = manifest.benchmarkBaseline;
              }
            } catch {
              // Ignore parse errors on manifest read
            }
          }

          for (let sample = 1; sample <= maxSamples; sample++) {
            if (params.abortSignal?.aborted) {
              finalOutcome = makeOutcome("abort", "cancelled", "Cancelled during benchmark sample collection");
              break;
            }

            const oracleRes = await runAndRecordStep({
              sessionId: params.sessionId,
              ledgerPath: params.ledgerPath,
              commitSha: params.commitSha,
              phase: oraclePhase,
              commandSpec: oracleCommandSpec,
              cwd: stepCwd,
              config: params.config,
              workspaceRoot: params.worktreePath,
              sessionDir: params.sessionDir,
              detectedToolchainVersion: detectedVersion,
              abortSignal: params.abortSignal,
              onEvent: params.onEvent,
              sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
            });
            lastRunResult = oracleRes;

            const infra = classifyProcessInfrastructureError(oracleRes, "oracle");
            if (infra) {
              finalOutcome = infra;
              break;
            }

            const parseResult = parseBenchmarkMetric(oracleRes.stdout, benchmarkConfig.metric, benchmarkConfig.unit);
            if (!parseResult.ok) {
              parseErrors++;
              lastParseError = parseResult.error;
              continue;
            }

            validSamples.push(parseResult.value);

            // Sequential early stopping: if baseline is present and minSamples reached
            if (baseline && validSamples.length >= minSamples) {
              const candidateStats = buildBenchmarkStats(validSamples, benchmarkConfig.metric, warmupRuns, benchmarkConfig.unit);
              const intermediateEval = evaluateBenchmarkRegression({
                baseline,
                candidate: candidateStats,
                config: benchmarkConfig,
              });

              if (intermediateEval.decision === "regression") {
                finalOutcome = {
                  ...makeOutcome("bad", "benchmark_regression_detected", intermediateEval.reason, "automated"),
                  benchmark: intermediateEval,
                };
                break;
              } else if (intermediateEval.decision === "non_regression" && intermediateEval.isSignificant) {
                finalOutcome = {
                  ...makeOutcome("good", "benchmark_within_tolerance", intermediateEval.reason, "automated"),
                  benchmark: intermediateEval,
                };
                break;
              }
            }
          }

          if (!finalOutcome) {
            if (validSamples.length < minSamples) {
              finalOutcome = makeOutcome(
                "skip",
                "benchmark_insufficient_samples",
                `Benchmark collection produced only ${validSamples.length} valid samples (minimum ${minSamples} required; ${parseErrors} parsing errors: ${lastParseError || "none"})`
              );
            } else if (baseline) {
              const candidateStats = buildBenchmarkStats(validSamples, benchmarkConfig.metric, warmupRuns, benchmarkConfig.unit);
              const finalEval = evaluateBenchmarkRegression({
                baseline,
                candidate: candidateStats,
                config: benchmarkConfig,
              });

              if (finalEval.decision === "regression") {
                finalOutcome = {
                  ...makeOutcome("bad", "benchmark_regression_detected", finalEval.reason, "automated"),
                  benchmark: finalEval,
                };
              } else if (finalEval.decision === "non_regression") {
                finalOutcome = {
                  ...makeOutcome("good", "benchmark_within_tolerance", finalEval.reason, "automated"),
                  benchmark: finalEval,
                };
              } else {
                finalOutcome = {
                  ...makeOutcome("skip", "benchmark_inconclusive", finalEval.reason, "automated"),
                  benchmark: finalEval,
                };
              }
            } else {
              // Establishing baseline (no prior baseline, e.g. goodRef during preflight)
              const baselineStats = buildBenchmarkStats(validSamples, benchmarkConfig.metric, warmupRuns, benchmarkConfig.unit);
              finalOutcome = {
                ...makeOutcome(
                  "good",
                  "oracle_passed",
                  `Benchmark baseline established for "${benchmarkConfig.metric}": mean ${baselineStats.mean.toFixed(2)}${benchmarkConfig.unit ? " " + benchmarkConfig.unit : ""} (stdDev: ${baselineStats.stdDev.toFixed(2)}, p50: ${baselineStats.median.toFixed(2)}) across ${validSamples.length} samples`,
                  "automated"
                ),
                benchmark: baselineStats,
              };
            }
          }
        }
      } else if (noisyPolicy?.enabled) {
        const maxSamples = noisyPolicy.maxSamplesPerRevision ?? 5;
        const confidenceThreshold = noisyPolicy.confidenceThreshold ?? 0.90;
        const flakeRate = noisyPolicy.flakeRate ?? 0.10;

        let passedRuns = 0;
        let failedRuns = 0;
        let skippedRuns = 0;

        for (let sample = 1; sample <= maxSamples; sample++) {
          if (params.abortSignal?.aborted) {
            finalOutcome = makeOutcome("abort", "cancelled", "Cancelled during noisy oracle sampling");
            break;
          }

          const oracleRes = await runAndRecordStep({
            sessionId: params.sessionId,
            ledgerPath: params.ledgerPath,
            commitSha: params.commitSha,
            phase: oraclePhase,
            commandSpec: oracleCommandSpec,
            cwd: stepCwd,
            config: params.config,
            workspaceRoot: params.worktreePath,
            sessionDir: params.sessionDir,
            detectedToolchainVersion: detectedVersion,
            abortSignal: params.abortSignal,
            onEvent: params.onEvent,
            sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
          });
          lastRunResult = oracleRes;

          const sampleOutcome = classifyOracleStep(oracleRes, params.config.profile);
          if (sampleOutcome.kind === "abort") {
            finalOutcome = sampleOutcome;
            break;
          } else if (sampleOutcome.kind === "good") {
            passedRuns++;
          } else if (sampleOutcome.kind === "bad") {
            failedRuns++;
          } else {
            skippedRuns++;
          }

          const evalResult = evaluateBayesianDecision({
            passes: passedRuns,
            fails: failedRuns,
            confidenceThreshold,
            flakeRate,
          });

          if (evalResult.decision === "bad") {
            finalOutcome = makeOutcome(
              "bad",
              "oracle_failed_expected_regression",
              `Noisy oracle classified revision as bad (P(bad)=${evalResult.posteriorBad.toFixed(4)} >= ${confidenceThreshold} after ${sample} samples; ${failedRuns} failed, ${passedRuns} passed)`,
              "automated",
              {
                sampleCount: sample,
                passedRuns,
                failedRuns,
                skippedRuns,
                posterior: evalResult.posteriorBad,
                confidenceThreshold,
              }
            );
            break;
          } else if (evalResult.decision === "good") {
            finalOutcome = makeOutcome(
              "good",
              "oracle_passed",
              `Noisy oracle classified revision as good (P(good)=${evalResult.posteriorGood.toFixed(4)} >= ${confidenceThreshold} after ${sample} samples; ${passedRuns} passed, ${failedRuns} failed)`,
              "automated",
              {
                sampleCount: sample,
                passedRuns,
                failedRuns,
                skippedRuns,
                posterior: evalResult.posteriorBad,
                confidenceThreshold,
              }
            );
            break;
          }
        }

        if (!finalOutcome) {
          const evalResult = evaluateBayesianDecision({
            passes: passedRuns,
            fails: failedRuns,
            confidenceThreshold,
            flakeRate,
          });
          finalOutcome = makeOutcome(
            "skip",
            "skip_budget_exceeded",
            `Noisy oracle sampling budget exhausted (${maxSamples} samples; ${passedRuns} passed, ${failedRuns} failed, ${skippedRuns} skipped) without reaching confidence threshold ${confidenceThreshold} (P(bad)=${evalResult.posteriorBad.toFixed(4)})`,
            "automated",
            {
              sampleCount: maxSamples,
              passedRuns,
              failedRuns,
              skippedRuns,
              posterior: evalResult.posteriorBad,
              confidenceThreshold,
            }
          );
        }
      } else {
        const oracleRes = await runAndRecordStep({
          sessionId: params.sessionId,
          ledgerPath: params.ledgerPath,
          commitSha: params.commitSha,
          phase: oraclePhase,
          commandSpec: oracleCommandSpec,
          cwd: stepCwd,
          config: params.config,
          workspaceRoot: params.worktreePath,
          sessionDir: params.sessionDir,
          detectedToolchainVersion: detectedVersion,
          abortSignal: params.abortSignal,
          onEvent: params.onEvent,
          sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
        });
        lastRunResult = oracleRes;

        finalOutcome = classifyOracleStep(oracleRes, params.config.profile);
      }
    }

    if (
      params.config.execution.interactivePrompt === true &&
      (params.phasePrefix === "oracle" || params.phasePrefix === undefined) &&
      finalOutcome
    ) {
      finalOutcome = await promptHumanClassification({
        commitSha: params.commitSha,
        commandSpec: oracleCommandSpec,
        automatedOutcome: finalOutcome,
        capturedOutput: lastRunResult ? { stdout: lastRunResult.stdout, stderr: lastRunResult.stderr } : undefined,
        executionInfo: lastRunResult?.timedOut
          ? `Command timed out after ${lastRunResult.durationMs}ms`
          : lastRunResult?.spawnErrorMessage
            ? `Spawn error: ${lastRunResult.spawnErrorMessage}`
            : undefined,
        streams: params.promptStreams,
        abortSignal: params.abortSignal,
      });
    }

    return finalOutcome!;
  } finally {
    for (const target of copiedOverlayTargets) {
      rmSync(target, { force: true, recursive: true });
    }
    if (copiedOverlayTargets.length > 0) {
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "cleanup_step",
          sessionId: params.sessionId,
          action: "overlay_removed",
          targetPath: copiedOverlayTargets.join(","),
          ok: copiedOverlayTargets.every((p) => !existsSync(p)),
        },
        params.onEvent
      );
    }
    if (finalOutcome) {
      let benchmarkRecord: Extract<LedgerEvent, { type: "revision_classified" }>["benchmark"] = undefined;
      if (finalOutcome.benchmark) {
        if ("decision" in finalOutcome.benchmark) {
          const b = finalOutcome.benchmark as BenchmarkEvaluationResult;
          benchmarkRecord = {
            metric: b.candidate.metric,
            unit: b.candidate.unit,
            sampleCount: b.candidate.count,
            warmupRuns: b.candidate.warmupRuns,
            mean: b.candidate.mean,
            variance: b.candidate.variance,
            stdDev: b.candidate.stdDev,
            median: b.candidate.median,
            p95: b.candidate.p95,
            p99: b.candidate.p99,
            baselineMean: b.baseline.mean,
            absoluteDelta: b.absoluteDelta,
            relativeDelta: b.relativeDelta,
            tStatistic: b.tStatistic,
            degreesOfFreedom: b.degreesOfFreedom,
            pValue: b.pValue,
            alpha: b.alpha,
            isSignificant: b.isSignificant,
            isPracticalRegression: b.isPracticalRegression,
            direction: b.direction,
            decision: b.decision,
            testName: "welch_ttest",
          };
        } else {
          const s = finalOutcome.benchmark as BenchmarkStats;
          benchmarkRecord = {
            metric: s.metric,
            unit: s.unit,
            sampleCount: s.count,
            warmupRuns: s.warmupRuns,
            mean: s.mean,
            variance: s.variance,
            stdDev: s.stdDev,
            median: s.median,
            p95: s.p95,
            p99: s.p99,
          };
        }
      }

      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "revision_classified",
          sessionId: params.sessionId,
          commitSha: params.commitSha,
          classification: finalOutcome.kind,
          reasonCode: finalOutcome.reasonCode,
          detail: finalOutcome.detail,
          gitExitCode: finalOutcome.gitExitCode,
          overlayHashes: params.overlayHashes,
          classifiedBy: finalOutcome.classifiedBy ?? "automated",
          ...(finalOutcome.noisySampling ? { noisySampling: finalOutcome.noisySampling } : {}),
          ...(benchmarkRecord ? { benchmark: benchmarkRecord } : {}),
          toolchainInfo: toolchainInfoRecord,
        },
        params.onEvent
      );
      recordClassificationTelemetry(params.config.oracle.mode, finalOutcome, Math.max(0, (Date.now() - startTime) / 1000), finalOutcome.benchmark);
    }
  }
}
  );
}
