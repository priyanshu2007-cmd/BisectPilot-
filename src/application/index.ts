import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeConfigHash } from "../config/index.js";
import { defaultMetrics } from "../telemetry/index.js";
import type {
  BisectConfigV1,
  BisectEngine,
  BisectPlanReport,
  CleanupOptions,
  CleanupResult,
  DoctorReport,
  LedgerEvent,
  SessionConclusion,
  SessionManifestV1,
  SessionStatusReport,
  StartSessionOptions,
} from "../contracts/index.js";
import type { BenchmarkStats } from "../domain/benchmark.js";
import {
  countCommitsBetween,
  ensureBisectPilotExcluded,
  getCurrentHead,
  getFirstParentSha,
  getGoodEndpointDiscoveryCandidates,
  isAncestor,
  isWorkingTreeDirty,
  resolveCommonGitDir,
  resolveRefToSha,
  resolveRepoRoot,
  runGit,
  runGitDoctor,
  type GitExecResult,
} from "../git/index.js";
import { appendLedgerEvent, readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import {
  evaluateCheckedOutRevision,
  sha256File,
  snapshotExternalScript,
  snapshotOverlayFiles,
} from "../oracle/index.js";
import { writeSessionReportArtifacts } from "../reports/index.js";
import {
  acquireSessionLock,
  detectCrashNeedsRecovery,
  inspectSessionLock,
  listSessionManifests,
  readSessionManifest,
  releaseSessionLock,
  syncCheckpointWithWal,
  TERMINAL_SESSION_STATES,
  transitionSessionState,
  writeSessionCheckpointAtomic,
  writeSessionManifestAtomic,
} from "../session/index.js";
import {
  createSessionWorktree,
  removeOwnedWorktree,
  resetOwnedWorktree,
  verifyWorktreeOwnership,
} from "../worktree/index.js";
import {
  minimizeInput,
  type MinimizeConfig,
  type MinimizeResult,
} from "../domain/minimizer.js";
import { resolveWorkspacePathScope, validateWorkspacePath } from "../domain/workspace.js";
import type { SandboxRuntimeExecutor } from "../process/index.js";

function resolveRunnerScriptPath(): string {

  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../runner/bisect-runner.js");
}

function defaultSessionRootDir(repoRoot: string, configuredRoot?: string): string {
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  return path.resolve(repoRoot, ".bisectpilot", "sessions");
}

async function runEndpointKTimes(params: {
  readonly manifest: SessionManifestV1;
  readonly target: "good_endpoint" | "bad_endpoint" | "candidate" | "candidate_parent";
  readonly commitSha: string;
  readonly runs: number;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
}): Promise<{
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly aborted: number;
}> {
  const worktreePath = params.manifest.repository.worktreePath;
  const coRes = await runGit(["checkout", "--detach", params.commitSha], worktreePath);
  if (coRes.exitCode !== 0) {
    throw new Error(`Failed to checkout ${params.commitSha} in worktree: ${coRes.stderr}`);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = 0;

  for (let i = 0; i < params.runs; i++) {
    await resetOwnedWorktree(params.manifest, {
      cleanIgnored: params.manifest.config.execution.cleanIgnored,
      overlayRelativePaths: params.manifest.config.oracle.overlayFiles,
    });

    const outcome = await evaluateCheckedOutRevision({
      sessionId: params.manifest.id,
      sessionDir: params.manifest.sessionDir,
      ledgerPath: params.manifest.ledgerPath,
      worktreePath,
      commitSha: params.commitSha,
      config: params.manifest.config,
      overlayHashes: params.manifest.overlayHashes,
      phasePrefix:
        params.target === "good_endpoint"
          ? "preflight_good"
          : params.target === "bad_endpoint"
            ? "preflight_bad"
            : "boundary_check",
      abortSignal: params.abortSignal,
      onEvent: params.onEvent,
      sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
      benchmarkBaseline: params.manifest.benchmarkBaseline,
    });

    await resetOwnedWorktree(params.manifest, {
      cleanIgnored: params.manifest.config.execution.cleanIgnored,
      overlayRelativePaths: params.manifest.config.oracle.overlayFiles,
    });

    if (outcome.kind === "good") passed++;
    else if (outcome.kind === "bad") failed++;
    else if (outcome.kind === "skip") skipped++;
    else {
      aborted++;
      break;
    }
  }

  appendLedgerEvent(
    params.manifest.ledgerPath,
    {
      type: "boundary_check",
      sessionId: params.manifest.id,
      target: params.target,
      commitSha: params.commitSha,
      totalRuns: params.runs,
      passedRuns: passed,
      failedRuns: failed,
      skippedRuns: skipped,
      abortedRuns: aborted,
    },
    params.onEvent
  );

  return { passed, failed, skipped, aborted };
}

function parseFirstBadShaFromBisectOutput(output: string, termNew = "bad"): string | undefined {
  const escapedTerm = termNew.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex1 = new RegExp(`\\b([0-9a-f]{40}) is the first (?:['"]?(?:${escapedTerm}|bad)['"]?) commit\\b`, "i");
  const match1 = regex1.exec(output);
  if (match1) return match1[1]!.toLowerCase();

  const regex2 = new RegExp(`# first (?:['"]?(?:${escapedTerm}|bad)['"]?) commit:\\s*\\[([0-9a-f]{40})\\]`, "i");
  const match2 = regex2.exec(output);
  if (match2) return match2[1]!.toLowerCase();

  const regex3 = /\b([0-9a-f]{40}) is the first ['"]?[^'"\r\n]+['"]? commit\b/i;
  const match3 = regex3.exec(output);
  if (match3) return match3[1]!.toLowerCase();

  const regex4 = /# first [^:\r\n]+ commit:\s*\[([0-9a-f]{40})\]/i;
  const match4 = regex4.exec(output);
  if (match4) return match4[1]!.toLowerCase();

  return undefined;
}

export class LocalBisectEngine implements BisectEngine {
  private readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;

  constructor(options?: { readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor }) {
    this.sandboxRuntimeExecutor = options?.sandboxRuntimeExecutor;
  }

  async doctor(repoPath = "."): Promise<DoctorReport> {
    return runGitDoctor(repoPath);
  }

  async plan(config: BisectConfigV1): Promise<BisectPlanReport> {
    const repoRoot = await resolveRepoRoot(config.repositoryRoot);
    const badSha = await resolveRefToSha(repoRoot, config.badRef);
    const dirty = await isWorkingTreeDirty(repoRoot);
    const warnings: string[] = [];

    if (config.workingDirectory && config.workingDirectory !== ".") {
      const wsVal = validateWorkspacePath(repoRoot, config.workingDirectory);
      if (!wsVal.ok) {
        return {
          ok: false,
          repoRoot,
          goodSha:
            config.goodRef === "auto"
              ? "auto"
              : await resolveRefToSha(repoRoot, config.goodRef).catch(() => "unknown"),
          badSha,
          isLinearAncestor: false,
          estimatedCommitsBetween: 0,
          estimatedSteps: 0,
          originalWasDirty: dirty,
          warnings: [`Workspace path error: ${wsVal.error}`],
        };
      }
      warnings.push(
        `Workspace mode active: path-scoped history limited to "${config.workingDirectory}" and root dependencies.`
      );
    }

    const pathScope = resolveWorkspacePathScope(repoRoot, config.workingDirectory || ".", config.pathScope);

    if (config.goodRef === "auto") {
      const candidates = await getGoodEndpointDiscoveryCandidates(repoRoot, badSha);
      if (dirty) {
        warnings.push(
          "Original working tree has uncommitted changes (BisectPilot will preserve them in place and bisect in an isolated detached worktree)."
        );
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          repoRoot,
          goodSha: "auto",
          badSha,
          isLinearAncestor: false,
          estimatedCommitsBetween: 0,
          estimatedSteps: 0,
          originalWasDirty: dirty,
          warnings: ["badRef has no ancestors in repository; automatic good discovery impossible."],
        };
      }
      warnings.push("goodRef is set to auto; good endpoint will be discovered dynamically from ancestor candidates.");
      return {
        ok: true,
        repoRoot,
        goodSha: "auto",
        badSha,
        isLinearAncestor: true,
        estimatedCommitsBetween: candidates.length,
        estimatedSteps: Math.ceil(Math.log2(candidates.length + 1)),
        originalWasDirty: dirty,
        warnings,
      };
    }

    const goodSha = await resolveRefToSha(repoRoot, config.goodRef);
    const linear = await isAncestor(repoRoot, goodSha, badSha);
    const commitsBetween = await countCommitsBetween(repoRoot, goodSha, badSha, pathScope);
    const steps = commitsBetween > 0 ? Math.ceil(Math.log2(commitsBetween + 1)) : 0;

    if (!linear) {
      warnings.push("goodRef is not a direct ancestor of badRef; non-linear history detected.");
    }
    if (dirty) {
      warnings.push(
        "Original working tree has uncommitted changes (BisectPilot will preserve them in place and bisect in an isolated detached worktree)."
      );
    }
    if (commitsBetween === 0 && pathScope && pathScope.length > 0) {
      warnings.push(
        `No commits found between ${goodSha.slice(0, 7)} and ${badSha.slice(0, 7)} affecting workspace "${config.workingDirectory}" or root dependencies.`
      );
    }
    if (config.profile === "performance" && config.benchmark) {
      warnings.push(
        `Performance benchmark mode active: measuring metric "${config.benchmark.metric}" (${config.benchmark.direction}, samples: ${config.benchmark.minSamples}-${config.benchmark.maxSamples}, alpha: ${config.benchmark.alpha}).`
      );
    }

    return {
      ok: linear && commitsBetween > 0,
      repoRoot,
      goodSha,
      badSha,
      isLinearAncestor: linear,
      estimatedCommitsBetween: commitsBetween,
      estimatedSteps: steps,
      originalWasDirty: dirty,
      warnings,
    };
  }

  async start(config: BisectConfigV1, options?: StartSessionOptions): Promise<SessionManifestV1> {
    const planReport = await this.plan(config);
    if (!planReport.ok) {
      throw new Error(`Cannot start bisection plan: ${planReport.warnings.join("; ") || "invalid bounds"}`);
    }
    const sessionId = options?.sessionId ?? `bp-${randomUUID().slice(0, 8)}`;
    const sessionsBase = defaultSessionRootDir(planReport.repoRoot, config.sessionRootDir);
    const sessionDir = path.join(sessionsBase, sessionId);
    const worktreeDir = path.join(sessionDir, "worktree");
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");

    mkdirSync(sessionDir, { recursive: true });
    acquireSessionLock(sessionDir);

    try {
      const commonGitDir = await resolveCommonGitDir(planReport.repoRoot);
      ensureBisectPilotExcluded(commonGitDir);
      const originalHead = await getCurrentHead(planReport.repoRoot);
      const overlayHashes: Record<string, string> =
        config.oracle.mode === "overlay" && config.oracle.overlayFiles
          ? snapshotOverlayFiles(planReport.repoRoot, sessionDir, config.oracle.overlayFiles)
          : {};

      if (config.oracle.mode === "external" && config.oracle.externalScriptPath) {
        const ext = snapshotExternalScript(
          planReport.repoRoot,
          sessionDir,
          config.oracle.externalScriptPath
        );
        overlayHashes[`external:${path.basename(config.oracle.externalScriptPath)}`] = ext.sha256;
      }

      const initialCommitSha = config.goodRef === "auto" ? planReport.badSha : planReport.goodSha;
      const repoMeta = await createSessionWorktree({
        sessionId,
        repoRoot: planReport.repoRoot,
        commonGitDir,
        originalHead,
        originalWasDirty: planReport.originalWasDirty,
        worktreePath: worktreeDir,
        initialCommitSha,
      });

      const now = new Date().toISOString();
      let manifest: SessionManifestV1 = {
        schemaVersion: 1,
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        state: "created",
        sessionDir,
        ledgerPath,
        repository: repoMeta,
        bounds: {
          goodInputRef: config.goodRef,
          goodSha: planReport.goodSha,
          badInputRef: config.badRef,
          badSha: planReport.badSha,
        },
        configHash: computeConfigHash(config),
        config,
        overlayHashes,
        skipCount: 0,
        testedRevisions: [],
        runnerVersion: "0.1.0",
      };

      writeSessionManifestAtomic(manifest);
      appendLedgerEvent(
        ledgerPath,
        {
          type: "session_created",
          sessionId,
          goodSha: planReport.goodSha,
          badSha: planReport.badSha,
          worktreePath: repoMeta.worktreePath,
          overlayHashes,
          ...(config.terms ? { terms: config.terms } : {}),
          ...(config.workingDirectory && config.workingDirectory !== "."
            ? { workingDirectory: config.workingDirectory }
            : {}),
          ...(config.pathScope ? { pathScope: config.pathScope } : {}),
          ...(config.benchmark ? { benchmark: config.benchmark } : {}),
        },
        options?.onEvent
      );

      writeSessionCheckpointAtomic(sessionDir, {
        schemaVersion: 1,
        sessionId,
        checkpointSeq: 1,
        lastWalSeq: 1,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        state: manifest.state,
        searchPhase: "preflight",
        repository: manifest.repository,
        bounds: manifest.bounds,
        configHash: manifest.configHash,
        config: manifest.config,
        overlayHashes: manifest.overlayHashes,
        classifications: {},
        testedRevisions: [],
        skipCount: 0,
      });

      if (config.goodRef === "auto") {
        return await this.discoverGoodEndpointAndRun(manifest, planReport, options);
      }

      if (config.execution.confirmBeforeExecutingCode && options?.confirm) {
        manifest = transitionSessionState(manifest, "awaiting_consent", "Requesting user consent", options?.onEvent);
        const approved = await options.confirm(planReport);
        if (!approved) {
          manifest = transitionSessionState(manifest, "cancelled", "User declined consent", options?.onEvent);
          return manifest;
        }
      }

      manifest = transitionSessionState(manifest, "worktree_ready", "Detached session worktree ready", options?.onEvent);
      return await this.executeInvestigationFromWorktreeReady(manifest, options);
    } finally {
      releaseSessionLock(sessionDir);
    }
  }

  private async discoverGoodEndpointAndRun(
    initialManifest: SessionManifestV1,
    planReport: BisectPlanReport,
    options?: StartSessionOptions
  ): Promise<SessionManifestV1> {
    let manifest = initialManifest;

    if (options?.abortSignal?.aborted) {
      return this.cancelSession(manifest, options);
    }

    manifest = transitionSessionState(
      manifest,
      "preflight_running",
      "Validating bad endpoint before good-endpoint discovery",
      options?.onEvent
    );

    // 1. Evaluate bad endpoint
    const badOutcome = await evaluateCheckedOutRevision({
      sessionId: manifest.id,
      sessionDir: manifest.sessionDir,
      ledgerPath: manifest.ledgerPath,
      worktreePath: manifest.repository.worktreePath,
      commitSha: manifest.bounds.badSha,
      config: manifest.config,
      overlayHashes: manifest.overlayHashes,
      phasePrefix: "preflight_bad",
      abortSignal: options?.abortSignal,
      onEvent: options?.onEvent,
      sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
    });

    if (options?.abortSignal?.aborted) {
      return this.cancelSession(manifest, options);
    }

    if (badOutcome.kind === "good") {
      return this.concludeSession(
        manifest,
        {
          outcome: "inconclusive",
          skippedShas: [],
          explanation:
            "Automatic discovery failed: bad endpoint passed oracle (cannot establish regression baseline when bad endpoint does not fail).",
        },
        options
      );
    }

    if (badOutcome.kind === "abort") {
      return this.concludeSession(
        manifest,
        {
          outcome: "aborted",
          skippedShas: [],
          explanation: `Bad endpoint execution aborted: ${badOutcome.detail}`,
        },
        options
      );
    }

    // 2. Discover ancestor candidates using tags and exponential distances
    const candidates = await getGoodEndpointDiscoveryCandidates(
      planReport.repoRoot,
      manifest.bounds.badSha
    );

    let discoveredGoodSha: string | null = null;

    for (const candidateSha of candidates) {
      if (options?.abortSignal?.aborted) {
        return this.cancelSession(manifest, options);
      }

      const coRes = await runGit(
        ["checkout", "--detach", candidateSha],
        manifest.repository.worktreePath
      );
      if (coRes.exitCode !== 0) continue;

      await resetOwnedWorktree(manifest, {
        cleanIgnored: manifest.config.execution.cleanIgnored,
        overlayRelativePaths: manifest.config.oracle.overlayFiles,
      });

      const candOutcome = await evaluateCheckedOutRevision({
        sessionId: manifest.id,
        sessionDir: manifest.sessionDir,
        ledgerPath: manifest.ledgerPath,
        worktreePath: manifest.repository.worktreePath,
        commitSha: candidateSha,
        config: manifest.config,
        overlayHashes: manifest.overlayHashes,
        phasePrefix: "preflight_good",
        abortSignal: options?.abortSignal,
        onEvent: options?.onEvent,
        sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
      });

      await resetOwnedWorktree(manifest, {
        cleanIgnored: manifest.config.execution.cleanIgnored,
        overlayRelativePaths: manifest.config.oracle.overlayFiles,
      });

      appendLedgerEvent(
        manifest.ledgerPath,
        {
          type: "boundary_check",
          sessionId: manifest.id,
          target: "good_endpoint",
          commitSha: candidateSha,
          totalRuns: 1,
          passedRuns: candOutcome.kind === "good" ? 1 : 0,
          failedRuns: candOutcome.kind === "bad" ? 1 : 0,
          skippedRuns: candOutcome.kind === "skip" ? 1 : 0,
          abortedRuns: candOutcome.kind === "abort" ? 1 : 0,
        },
        options?.onEvent
      );

      if (candOutcome.kind === "good") {
        discoveredGoodSha = candidateSha;
        break;
      }
    }

    if (!discoveredGoodSha) {
      return this.concludeSession(
        manifest,
        {
          outcome: "inconclusive",
          skippedShas: [],
          explanation:
            "Automatic good-endpoint discovery exhausted candidate history without finding a commit passing the oracle.",
        },
        options
      );
    }

    // 3. Update manifest and config with discovered good endpoint
    manifest = {
      ...manifest,
      bounds: {
        ...manifest.bounds,
        goodSha: discoveredGoodSha,
      },
      config: {
        ...manifest.config,
        goodRef: discoveredGoodSha,
      },
    };
    writeSessionManifestAtomic(manifest);

    // 4. Request consent if configured
    if (manifest.config.execution.confirmBeforeExecutingCode && options?.confirm) {
      manifest = transitionSessionState(
        manifest,
        "awaiting_consent",
        `Discovered good baseline: ${discoveredGoodSha}`,
        options?.onEvent
      );
      const updatedPlan = await this.plan(manifest.config);
      const approved = await options.confirm(updatedPlan);
      if (!approved) {
        manifest = transitionSessionState(
          manifest,
          "cancelled",
          "User declined consent after good-endpoint discovery",
          options?.onEvent
        );
        return manifest;
      }
    }

    manifest = transitionSessionState(
      manifest,
      "worktree_ready",
      `Discovered good endpoint ${discoveredGoodSha}; ready for bisection`,
      options?.onEvent
    );

    // 5. Continue to bisection (skip preflight since endpoints were already verified during discovery)
    return await this.executeInvestigationFromWorktreeReady(manifest, {
      ...options,
      skipPreflight: true,
    });
  }

  private cancelSession(
    manifest: SessionManifestV1,
    options?: StartSessionOptions
  ): SessionManifestV1 {
    let next = transitionSessionState(
      manifest,
      "cancel_requested",
      "Cancellation requested via AbortSignal",
      options?.onEvent
    );
    next = transitionSessionState(
      next,
      "cancelled",
      "Session cancelled cleanly",
      options?.onEvent
    );
    return next;
  }

  private async executeInvestigationFromWorktreeReady(
    initialManifest: SessionManifestV1,
    options?: StartSessionOptions
  ): Promise<SessionManifestV1> {
    let manifest = initialManifest;

    if (options?.abortSignal?.aborted) {
      return this.cancelSession(manifest, options);
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
          sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
        });

        if (options?.abortSignal?.aborted) {
          return this.cancelSession(manifest, options);
        }

        if (goodOutcome.kind === "abort") {
          return this.concludeSession(
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
          return this.concludeSession(
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
          sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
          benchmarkBaseline: baselineStats,
        });

        await resetOwnedWorktree(manifest, {
          cleanIgnored: manifest.config.execution.cleanIgnored,
          overlayRelativePaths: manifest.config.oracle.overlayFiles,
        });

        if (options?.abortSignal?.aborted) {
          return this.cancelSession(manifest, options);
        }

        if (badOutcome.kind === "abort") {
          return this.concludeSession(
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
          return this.concludeSession(
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
          sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
        });

      if (options?.abortSignal?.aborted) {
        return this.cancelSession(manifest, options);
      }

      if (goodCheck.aborted > 0) {
        return this.concludeSession(
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
        sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
      });

      if (options?.abortSignal?.aborted) {
        return this.cancelSession(manifest, options);
      }

      if (badCheck.aborted > 0) {
        return this.concludeSession(
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
        return this.concludeSession(
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
          return this.concludeSession(
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
          return this.concludeSession(
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
      return this.concludeSession(
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
      return this.concludeSession(
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
      return this.concludeSession(
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
        return this.concludeSession(
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
      return this.concludeSession(
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
      sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
    });
    const parentConfirm = await runEndpointKTimes({
      manifest,
      target: "candidate_parent",
      commitSha: parentSha,
      runs: confirmRuns,
      abortSignal: options?.abortSignal,
      onEvent: options?.onEvent,
      sandboxRuntimeExecutor: this.sandboxRuntimeExecutor,
    });

    const noisyPolicy = manifest.config.execution.noisyOracle;
    const confirmed = noisyPolicy?.enabled
      ? candConfirm.failed / confirmRuns >= 1 - (noisyPolicy.flakeRate ?? 0.10) &&
        parentConfirm.passed / confirmRuns >= 1 - (noisyPolicy.flakeRate ?? 0.10)
      : candConfirm.failed === confirmRuns && parentConfirm.passed === confirmRuns;
    defaultMetrics.candidateBoundaryVerificationsTotal.inc({ outcome: confirmed ? "candidate_confirmed" : "candidate_unconfirmed" });
    const firstBadLabel = manifest.config.terms?.new ? `first ${manifest.config.terms.new}` : "first bad";
    return this.concludeSession(
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

  private async concludeSession(
    manifest: SessionManifestV1,
    conclusion: SessionConclusion,
    options?: StartSessionOptions,
    bisectLogText?: string
  ): Promise<SessionManifestV1> {
    if (conclusion.outcome === "aborted") {
      console.error(`[BisectEngine] Session ${manifest.id} ABORTED: ${conclusion.explanation}`);
    }
    let next = transitionSessionState(
      manifest,
      "concluded",
      `Session concluded with outcome: ${conclusion.outcome}`,
      options?.onEvent
    );
    next = {
      ...next,
      conclusion,
      updatedAt: new Date().toISOString(),
    };
    writeSessionManifestAtomic(next);
    appendLedgerEvent(
      next.ledgerPath,
      {
        type: "session_concluded",
        sessionId: next.id,
        conclusion,
      },
      options?.onEvent
    );

    try {
      syncCheckpointWithWal(next.sessionDir);
    } catch {
      // Non-fatal if checkpoint sync fails
    }

    const events = readLedgerEvents(next.ledgerPath);
    writeSessionReportArtifacts({
      manifest: next,
      events,
      ...(bisectLogText ? { bisectLogText } : {}),
    });

    if (options?.autoCleanup) {
      await this.cleanup(next.id, { dryRun: false }, path.dirname(next.sessionDir));
      next = readSessionManifest(next.sessionDir);
    }
    return next;
  }

  async status(sessionId: string, sessionRootDir?: string): Promise<SessionStatusReport> {
    const baseDir = sessionRootDir
      ? path.resolve(sessionRootDir)
      : path.resolve(".bisectpilot", "sessions");
    const sessionDir = path.join(baseDir, sessionId);
    let manifest = readSessionManifest(sessionDir);
    manifest = detectCrashNeedsRecovery(manifest);
    const lockInfo = inspectSessionLock(sessionDir);
    const events = readLedgerEvents(manifest.ledgerPath);
    const chain = verifyLedgerChain(events);

    let checkpointInfo;
    try {
      const cp = syncCheckpointWithWal(sessionDir);
      checkpointInfo = {
        checkpointSeq: cp.checkpointSeq,
        lastWalSeq: cp.lastWalSeq,
        classifiedCount: Object.keys(cp.classifications).length,
        searchPhase: cp.searchPhase,
        resumable: manifest.state === "needs_recovery" || manifest.state === "paused" || manifest.state === "bisect_running",
      };
    } catch {
      // Non-fatal
    }

    return {
      manifest,
      lockStatus: lockInfo.status,
      ...(lockInfo.holder ? { staleLockHolder: lockInfo.holder } : {}),
      eventCount: events.length,
      ledgerValid: chain.valid,
      ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
    };
  }

  async resume(
    sessionId: string,
    options?: StartSessionOptions,
    sessionRootDir?: string
  ): Promise<SessionManifestV1> {
    const baseDir = sessionRootDir
      ? path.resolve(sessionRootDir)
      : path.resolve(process.env.BISECTPILOT_SESSION_ROOT ?? ".bisectpilot/sessions");
    const sessionDir = path.join(baseDir, sessionId);
    let manifest = readSessionManifest(sessionDir);
    manifest = detectCrashNeedsRecovery(manifest, options?.onEvent);

    if (manifest.state === "concluded" || TERMINAL_SESSION_STATES.has(manifest.state)) {
      return manifest;
    }

    if (manifest.state !== "needs_recovery" && manifest.state !== "paused" && manifest.state !== "bisect_running") {
      throw new Error(`Session ${sessionId} cannot be resumed from state "${manifest.state}"`);
    }

    try {
      syncCheckpointWithWal(sessionDir);
    } catch {
      // Non-fatal if checkpoint sync fails
    }

    await verifyWorktreeOwnership(manifest, manifest.repository.worktreePath);
    if (computeConfigHash(manifest.config) !== manifest.configHash) {
      throw new Error("Session configHash mismatch; refusing to resume tampered session");
    }

    for (const [relPath, expectedHash] of Object.entries(manifest.overlayHashes)) {
      if (relPath.startsWith("external:")) {
        const extName = relPath.slice("external:".length);
        const extFile = path.resolve(manifest.sessionDir, "external", extName);
        if (!existsSync(extFile) || sha256File(extFile) !== expectedHash) {
          throw new Error(`External script snapshot integrity check failed for ${extName}`);
        }
        continue;
      }
      const snapFile = path.resolve(manifest.sessionDir, "overlays", relPath);
      if (!existsSync(snapFile) || sha256File(snapFile) !== expectedHash) {
        throw new Error(`Overlay snapshot integrity check failed for ${relPath}`);
      }
    }

    releaseSessionLock(sessionDir, true);
    acquireSessionLock(sessionDir);
    try {
      return await this.executeInvestigationFromWorktreeReady(manifest, {
        ...options,
        skipPreflight: true,
      });
    } finally {
      releaseSessionLock(sessionDir);
    }
  }

  async cleanup(
    sessionId: string,
    options?: CleanupOptions,
    sessionRootDir?: string
  ): Promise<CleanupResult> {
    const baseDir = sessionRootDir
      ? path.resolve(sessionRootDir)
      : path.resolve(".bisectpilot", "sessions");
    const sessionDir = path.join(baseDir, sessionId);
    let manifest = readSessionManifest(sessionDir);
    const dryRun = Boolean(options?.dryRun);

    if (dryRun) {
      await verifyWorktreeOwnership(manifest, manifest.repository.worktreePath);
      return {
        sessionId,
        worktreePath: manifest.repository.worktreePath,
        dryRun: true,
        removedWorktree: false,
        state: manifest.state,
        detail: `Dry-run verified ownership of ${manifest.repository.worktreePath}`,
      };
    }

    manifest = transitionSessionState(manifest, "cleanup_running", "Cleaning up session worktree");
    try {
      const rem = await removeOwnedWorktree(manifest, { dryRun: false });
      appendLedgerEvent(manifest.ledgerPath, {
        type: "cleanup_step",
        sessionId: manifest.id,
        action: "worktree_removed",
        targetPath: rem.worktreePath,
        ok: rem.removed,
      });
      manifest = transitionSessionState(
        manifest,
        rem.removed ? "cleaned_up" : "cleanup_failed",
        rem.removed ? "Removed session worktree" : "Worktree removal incomplete"
      );
      releaseSessionLock(sessionDir, true);
      return {
        sessionId,
        worktreePath: rem.worktreePath,
        dryRun: false,
        removedWorktree: rem.removed,
        state: manifest.state,
        detail: rem.removed ? "Cleaned up tool-owned worktree" : "Failed to remove worktree",
      };
    } catch (err: unknown) {
      manifest = transitionSessionState(manifest, "cleanup_failed", (err as Error).message);
      throw err;
    }
  }

  async list(sessionRootDir?: string): Promise<readonly SessionManifestV1[]> {
    const baseDir = sessionRootDir
      ? path.resolve(sessionRootDir)
      : path.resolve(".bisectpilot", "sessions");
    return listSessionManifests(baseDir);
  }

  async minimize(config: MinimizeConfig): Promise<MinimizeResult> {
    return minimizeInput(config);
  }
}
