import { defaultMetrics } from "../telemetry/index.js";
import { resolveWorkspacePathScope } from "../domain/workspace.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  InconclusiveReasonCode,
  OracleOutcome,
  SessionConclusion,
  SessionManifestV1,
  SessionOutcomeKind,
  LedgerEvent,
  StartSessionOptions,
} from "../contracts/index.js";
import type { BenchmarkEvaluationResult, BenchmarkStats } from "../domain/benchmark.js";
import {
  countCommitsBetween,
  getCurrentHead,
  getFirstParentSha,
  isAncestor,
  resolveRefToSha,
  runGit,
  type GitExecResult,
} from "../git/index.js";
import { appendLedgerEvent, readLedgerEvents } from "../ledger/index.js";
import { evaluateCheckedOutRevision } from "../oracle/index.js";
import type { SandboxRuntimeExecutor } from "../process/index.js";
import {
  syncCheckpointWithWal,
  transitionSessionState,
  writeSessionCheckpointAtomic,
  readSessionManifest,
  writeSessionManifestAtomic,
} from "../session/index.js";
import { resetOwnedWorktree } from "../worktree/index.js";
import { cancelSession, concludeSession } from "./lifecycle.js";
import {
  parseFirstBadShaFromBisectOutput,
  resolveRunnerScriptPath,
  runEndpointKTimes,
} from "./preflight.js";

export async function executeInvestigationFromWorktreeReady(
  initialManifest: SessionManifestV1,
  options?: StartSessionOptions,
  sandboxRuntimeExecutor?: SandboxRuntimeExecutor
): Promise<SessionManifestV1> {
  let manifest = initialManifest;

  if (options?.abortSignal?.aborted) {
    return cancelSession(manifest, options);
  }

  if (!options?.skipPreflight) {
    manifest = transitionSessionState(
      manifest,
      "preflight_running",
      "Running endpoint preflight checks",
      options?.onEvent
    );

    if (manifest.config.profile === "performance" && manifest.config.benchmark) {
      const worktreePath = manifest.repository.worktreePath;

      // 1. Establish baseline at good endpoint
      const goodCo = await runGit(["checkout", "--detach", manifest.bounds.goodSha], worktreePath);
      if (goodCo.exitCode !== 0) {
        throw new Error(`Failed to checkout good endpoint ${manifest.bounds.goodSha}: ${goodCo.stderr}`);
      }
      await resetOwnedWorktree(manifest, {
        cleanIgnored: manifest.config.execution.cleanIgnored,
        overlayRelativePaths: manifest.config.oracle.overlayFiles,
      });

      const goodOutcome = await evaluateCheckedOutRevision({
        sessionId: manifest.id,
        sessionDir: manifest.sessionDir,
        ledgerPath: manifest.ledgerPath,
        worktreePath,
        commitSha: manifest.bounds.goodSha,
        config: manifest.config,
        overlayHashes: manifest.overlayHashes,
        phasePrefix: "preflight_good",
        abortSignal: options?.abortSignal,
        onEvent: options?.onEvent,
        sandboxRuntimeExecutor: sandboxRuntimeExecutor,
      });

      if (options?.abortSignal?.aborted) {
        return cancelSession(manifest, options);
      }

      if (goodOutcome.kind === "abort") {
        return concludeSession(
          manifest,
          {
            outcome: "aborted",
            skippedShas: [],
            explanation: `Good endpoint benchmark aborted: ${goodOutcome.detail}`,
          },
          options
        );
      }

      if (goodOutcome.kind !== "good" || !goodOutcome.benchmark) {
        return concludeSession(
          manifest,
          {
            outcome: "inconclusive",
            skippedShas: [],
            explanation: `Failed to establish valid benchmark baseline at good endpoint: ${goodOutcome.detail}`,
          },
          options
        );
      }

      const baselineStats = ("decision" in goodOutcome.benchmark
        ? goodOutcome.benchmark.candidate
        : goodOutcome.benchmark) as BenchmarkStats;

      manifest = {
        ...manifest,
        benchmarkBaseline: baselineStats,
      };
      writeSessionManifestAtomic(manifest);

      // 2. Evaluate bad endpoint against established baseline
      const badCo = await runGit(["checkout", "--detach", manifest.bounds.badSha], worktreePath);
      if (badCo.exitCode !== 0) {
        throw new Error(`Failed to checkout bad endpoint ${manifest.bounds.badSha}: ${badCo.stderr}`);
      }
      await resetOwnedWorktree(manifest, {
        cleanIgnored: manifest.config.execution.cleanIgnored,
        overlayRelativePaths: manifest.config.oracle.overlayFiles,
      });

      const badOutcome = await evaluateCheckedOutRevision({
        sessionId: manifest.id,
        sessionDir: manifest.sessionDir,
        ledgerPath: manifest.ledgerPath,
        worktreePath,
        commitSha: manifest.bounds.badSha,
        config: manifest.config,
        overlayHashes: manifest.overlayHashes,
        phasePrefix: "preflight_bad",
        abortSignal: options?.abortSignal,
        onEvent: options?.onEvent,
        sandboxRuntimeExecutor: sandboxRuntimeExecutor,
        benchmarkBaseline: baselineStats,
      });

      await resetOwnedWorktree(manifest, {
        cleanIgnored: manifest.config.execution.cleanIgnored,
        overlayRelativePaths: manifest.config.oracle.overlayFiles,
      });

      if (options?.abortSignal?.aborted) {
        return cancelSession(manifest, options);
      }

      if (badOutcome.kind === "abort") {
        return concludeSession(
          manifest,
          {
            outcome: "aborted",
            skippedShas: [],
            explanation: `Bad endpoint benchmark aborted: ${badOutcome.detail}`,
          },
          options
        );
      }

      if (badOutcome.kind !== "bad") {
        return concludeSession(
          manifest,
          {
            outcome: "inconclusive",
            inconclusiveReason: "endpoints_contradict",
            skippedShas: [],
            explanation: `Benchmark endpoint contradiction: good endpoint baseline is ${baselineStats.mean.toFixed(2)}${manifest.config.benchmark?.unit ? " " + manifest.config.benchmark.unit : ""}, but bad endpoint did not exhibit performance regression (${badOutcome.detail}).`,
          },
          options
        );
      }

      manifest = transitionSessionState(
        manifest,
        "worktree_ready",
        "Endpoint preflight passed; benchmark baseline established and regression confirmed",
        options?.onEvent
      );
    } else {
      const k = manifest.config.execution.endpointFlakeRuns;

      const goodCheck = await runEndpointKTimes({
        manifest,
        target: "good_endpoint",
        commitSha: manifest.bounds.goodSha,
        runs: k,
        abortSignal: options?.abortSignal,
        onEvent: options?.onEvent,
        sandboxRuntimeExecutor: sandboxRuntimeExecutor,
      });

    if (options?.abortSignal?.aborted) {
      return cancelSession(manifest, options);
    }

    if (goodCheck.aborted > 0) {
      return concludeSession(
        manifest,
        {
          outcome: "aborted",
          skippedShas: [],
          explanation: "Good endpoint check aborted due to infrastructure/configuration error.",
        },
        options
      );
    }

    const badCheck = await runEndpointKTimes({
      manifest,
      target: "bad_endpoint",
      commitSha: manifest.bounds.badSha,
      runs: k,
      abortSignal: options?.abortSignal,
      onEvent: options?.onEvent,
      sandboxRuntimeExecutor: sandboxRuntimeExecutor,
    });

    if (options?.abortSignal?.aborted) {
      return cancelSession(manifest, options);
    }

    if (badCheck.aborted > 0) {
      return concludeSession(
        manifest,
        {
          outcome: "aborted",
          skippedShas: [],
          explanation: "Bad endpoint check aborted due to infrastructure/configuration error.",
        },
        options
      );
    }

    if (goodCheck.failed === k || badCheck.passed === k) {
      return concludeSession(
        manifest,
        {
          outcome: "inconclusive",
          inconclusiveReason: "endpoints_contradict",
          skippedShas: [],
          explanation: `Endpoint contradiction: good endpoint passed ${goodCheck.passed}/${k}, bad endpoint failed ${badCheck.failed}/${k}.`,
        },
        options
      );
    }

    const noisyPolicy = manifest.config.execution.noisyOracle;
    if (noisyPolicy?.enabled) {
      const maxFlakeRate = noisyPolicy.flakeRate ?? 0.10;
      const goodFailRate = goodCheck.failed / k;
      const badPassRate = badCheck.passed / k;
      if (goodFailRate > maxFlakeRate || badPassRate > maxFlakeRate) {
        return concludeSession(
          manifest,
          {
            outcome: "inconclusive",
            inconclusiveReason: "oracle_flaky_at_endpoints",
            skippedShas: [],
            explanation: `Oracle flake rate at endpoints exceeds tolerable limit (${(maxFlakeRate * 100).toFixed(1)}%): good failed ${(goodFailRate * 100).toFixed(1)}% (${goodCheck.failed}/${k}), bad passed ${(badPassRate * 100).toFixed(1)}% (${badCheck.passed}/${k}).`,
          },
          options
        );
      }
    } else {
      if (goodCheck.passed < k || badCheck.failed < k) {
        return concludeSession(
          manifest,
          {
            outcome: "inconclusive",
            inconclusiveReason: "oracle_flaky_at_endpoints",
            skippedShas: [],
            explanation: `Flaky oracle at endpoints: good passed ${goodCheck.passed}/${k}, bad failed ${badCheck.failed}/${k}.`,
          },
          options
        );
      }
    }

      manifest = transitionSessionState(
        manifest,
        "worktree_ready",
        "Endpoint preflight passed; worktree ready for git bisect",
        options?.onEvent
      );
    }
  }

  manifest = transitionSessionState(
    manifest,
    "bisect_running",
    "Starting native git bisect in session worktree",
    options?.onEvent
  );

  const worktreePath = manifest.repository.worktreePath;
  await runGit(["bisect", "reset"], worktreePath).catch(() => undefined);

  const startArgs = ["bisect", "start"];
  if (manifest.config.terms) {
    startArgs.push(`--term-old=${manifest.config.terms.old}`, `--term-new=${manifest.config.terms.new}`);
  }
  startArgs.push(manifest.bounds.badSha, manifest.bounds.goodSha);
  const pathScope = resolveWorkspacePathScope(
    worktreePath,
    manifest.config.workingDirectory,
    manifest.config.pathScope
  );
  if (pathScope && pathScope.length > 0) {
    startArgs.push("--", ...pathScope);
  }

  const startRes = await runGit(startArgs, worktreePath);
  if (startRes.exitCode !== 0) {
    return concludeSession(
      manifest,
      {
        outcome: "aborted",
        skippedShas: [],
        explanation: `git bisect start failed: ${startRes.stderr}`,
      },
      options
    );
  }

  let candidateSha = parseFirstBadShaFromBisectOutput(startRes.stdout, manifest.config.terms?.new);
  let runRes: GitExecResult | undefined;

  if (!candidateSha) {
    const runnerScript = resolveRunnerScriptPath().replace(/\\/g, "/");
    const sessionDirArg = manifest.sessionDir.replace(/\\/g, "/");
    const execPathArg = process.execPath.replace(/\\/g, "/");
    runRes = await runGit(
      ["bisect", "run", execPathArg, runnerScript, "--session-dir", sessionDirArg],
      worktreePath
    );
  }

  manifest = {
    ...readSessionManifest(manifest.sessionDir),
    state: "bisect_running",
  };

  const bisectLogRes = await runGit(["bisect", "log"], worktreePath);
  await runGit(["bisect", "reset"], worktreePath).catch(() => undefined);

  const events = readLedgerEvents(manifest.ledgerPath);
  const classifiedEvents = events.filter(
    (e): e is Extract<LedgerEvent, { type: "revision_classified" }> => e.type === "revision_classified"
  );
  const skippedShas = [
    ...new Set(classifiedEvents.filter((e) => e.classification === "skip").map((e) => e.commitSha)),
  ];

  if (manifest.skipCount > manifest.config.execution.maxSkips) {
    return concludeSession(
      manifest,
      {
        outcome: "inconclusive",
        inconclusiveReason: "skip_budget_exceeded",
        skippedShas,
        explanation: `Skip budget exceeded (${manifest.skipCount} > ${manifest.config.execution.maxSkips}).`,
      },
      options,
      bisectLogRes.stdout
    );
  }

  const abortedEvent = classifiedEvents.find((e) => e.classification === "abort");
  if (abortedEvent || (runRes && runRes.exitCode >= 128)) {
    return concludeSession(
      manifest,
      {
        outcome: "aborted",
        skippedShas,
        explanation: abortedEvent
          ? `Bisect aborted at ${abortedEvent.commitSha.slice(0, 8)} (${abortedEvent.reasonCode}): ${abortedEvent.detail}`
          : `git bisect run aborted (exit ${runRes?.exitCode}): ${runRes?.stderr || runRes?.stdout}`,
      },
      options,
      bisectLogRes.stdout
    );
  }

  const combinedOutput = `${startRes.stdout}\n${runRes?.stdout ?? ""}\n${bisectLogRes.stdout}`;
  if (!candidateSha) {
    candidateSha = parseFirstBadShaFromBisectOutput(combinedOutput, manifest.config.terms?.new);
  }

  if (!candidateSha) {
    if (skippedShas.length > 0) {
      return concludeSession(
        manifest,
        {
          outcome: "candidate_range",
          candidateRangeShas: skippedShas,
          skippedShas,
          explanation: "Skipped revisions prevented isolating a single commit; reporting candidate range.",
        },
        options,
        bisectLogRes.stdout
      );
    }
    return concludeSession(
      manifest,
      {
        outcome: "aborted",
        skippedShas,
        explanation: `Could not parse first bad commit from git bisect output: ${runRes?.stdout ?? startRes.stdout}`,
      },
      options,
      bisectLogRes.stdout
    );
  }

  manifest = transitionSessionState(
    manifest,
    "boundary_verifying",
    `Verifying candidate ${candidateSha.slice(0, 8)} and its first parent`,
    options?.onEvent
  );

  const parentSha = (await getFirstParentSha(worktreePath, candidateSha)) ?? manifest.bounds.goodSha;
  const confirmRuns = manifest.config.execution.boundaryConfirmRuns;

  const candConfirm = await runEndpointKTimes({
    manifest,
    target: "candidate",
    commitSha: candidateSha,
    runs: confirmRuns,
    abortSignal: options?.abortSignal,
    onEvent: options?.onEvent,
    sandboxRuntimeExecutor: sandboxRuntimeExecutor,
  });
  const parentConfirm = await runEndpointKTimes({
    manifest,
    target: "candidate_parent",
    commitSha: parentSha,
    runs: confirmRuns,
    abortSignal: options?.abortSignal,
    onEvent: options?.onEvent,
    sandboxRuntimeExecutor: sandboxRuntimeExecutor,
  });

  const noisyPolicy = manifest.config.execution.noisyOracle;
  const confirmed = noisyPolicy?.enabled
    ? candConfirm.failed / confirmRuns >= 1 - (noisyPolicy.flakeRate ?? 0.10) &&
      parentConfirm.passed / confirmRuns >= 1 - (noisyPolicy.flakeRate ?? 0.10)
    : candConfirm.failed === confirmRuns && parentConfirm.passed === confirmRuns;
  defaultMetrics.candidateBoundaryVerificationsTotal.inc({ outcome: confirmed ? "candidate_confirmed" : "candidate_unconfirmed" });
  const firstBadLabel = manifest.config.terms?.new ? `first ${manifest.config.terms.new}` : "first bad";
  return concludeSession(
    manifest,
    {
      outcome: confirmed ? "candidate_confirmed" : "candidate_unconfirmed",
      candidateSha,
      parentSha,
      skippedShas,
      explanation: confirmed
        ? `Confirmed ${candidateSha} as ${firstBadLabel} commit (${candConfirm.failed}/${confirmRuns} bad; parent ${parentSha.slice(0, 8)} ${parentConfirm.passed}/${confirmRuns} good).`
        : `Candidate ${candidateSha} identified by git bisect, but boundary confirmation varied (candidate bad ${candConfirm.failed}/${confirmRuns}, parent good ${parentConfirm.passed}/${confirmRuns}).`,
    },
    options,
    bisectLogRes.stdout
  );
  }
