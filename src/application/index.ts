import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeConfigHash } from "../config/index.js";
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
import {
  countCommitsBetween,
  getCurrentHead,
  getFirstParentSha,
  isAncestor,
  isWorkingTreeDirty,
  resolveCommonGitDir,
  resolveRefToSha,
  resolveRepoRoot,
  runGit,
  runGitDoctor,
} from "../git/index.js";
import { appendLedgerEvent, readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import { evaluateCheckedOutRevision, sha256File, snapshotOverlayFiles } from "../oracle/index.js";
import {
  acquireSessionLock,
  detectCrashNeedsRecovery,
  inspectSessionLock,
  listSessionManifests,
  readSessionManifest,
  releaseSessionLock,
  transitionSessionState,
  writeSessionManifestAtomic,
} from "../session/index.js";
import {
  createSessionWorktree,
  removeOwnedWorktree,
  resetOwnedWorktree,
  verifyWorktreeOwnership,
} from "../worktree/index.js";

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

function parseFirstBadShaFromBisectOutput(output: string): string | undefined {
  const match = /\b([0-9a-f]{40}) is the first bad commit\b/i.exec(output);
  return match ? match[1]!.toLowerCase() : undefined;
}

export class LocalBisectEngine implements BisectEngine {
  async doctor(repoPath = "."): Promise<DoctorReport> {
    return runGitDoctor(repoPath);
  }

  async plan(config: BisectConfigV1): Promise<BisectPlanReport> {
    const repoRoot = await resolveRepoRoot(config.repositoryRoot);
    const goodSha = await resolveRefToSha(repoRoot, config.goodRef);
    const badSha = await resolveRefToSha(repoRoot, config.badRef);
    const linear = await isAncestor(repoRoot, goodSha, badSha);
    const commitsBetween = await countCommitsBetween(repoRoot, goodSha, badSha);
    const steps = commitsBetween > 0 ? Math.ceil(Math.log2(commitsBetween + 1)) : 0;
    const dirty = await isWorkingTreeDirty(repoRoot);
    const warnings: string[] = [];

    if (!linear) {
      warnings.push("goodRef is not a direct ancestor of badRef; non-linear history detected.");
    }
    if (dirty) {
      warnings.push(
        "Original working tree has uncommitted changes (BisectPilot will preserve them in place and bisect in an isolated detached worktree)."
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
    const sessionId = options?.sessionId ?? `bp-${randomUUID().slice(0, 8)}`;
    const sessionsBase = defaultSessionRootDir(planReport.repoRoot, config.sessionRootDir);
    const sessionDir = path.join(sessionsBase, sessionId);
    const worktreeDir = path.join(sessionDir, "worktree");
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");

    mkdirSync(sessionDir, { recursive: true });
    acquireSessionLock(sessionDir);

    try {
      const commonGitDir = await resolveCommonGitDir(planReport.repoRoot);
      const originalHead = await getCurrentHead(planReport.repoRoot);
      const overlayHashes =
        config.oracle.mode === "overlay" && config.oracle.overlayFiles
          ? snapshotOverlayFiles(planReport.repoRoot, sessionDir, config.oracle.overlayFiles)
          : {};

      const repoMeta = await createSessionWorktree({
        sessionId,
        repoRoot: planReport.repoRoot,
        commonGitDir,
        originalHead,
        originalWasDirty: planReport.originalWasDirty,
        worktreePath: worktreeDir,
        initialCommitSha: planReport.goodSha,
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
        },
        options?.onEvent
      );

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

  private async executeInvestigationFromWorktreeReady(
    initialManifest: SessionManifestV1,
    options?: StartSessionOptions
  ): Promise<SessionManifestV1> {
    let manifest = initialManifest;

    if (!options?.skipPreflight) {
      manifest = transitionSessionState(
        manifest,
        "preflight_running",
        "Running endpoint preflight checks",
        options?.onEvent
      );
      const k = manifest.config.execution.endpointFlakeRuns;

      const goodCheck = await runEndpointKTimes({
        manifest,
        target: "good_endpoint",
        commitSha: manifest.bounds.goodSha,
        runs: k,
        abortSignal: options?.abortSignal,
        onEvent: options?.onEvent,
      });

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
      });

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

      manifest = transitionSessionState(
        manifest,
        "worktree_ready",
        "Endpoint preflight passed; worktree ready for git bisect",
        options?.onEvent
      );
    }

    manifest = transitionSessionState(
      manifest,
      "bisect_running",
      "Starting native git bisect in session worktree",
      options?.onEvent
    );

    const worktreePath = manifest.repository.worktreePath;
    await runGit(["bisect", "reset"], worktreePath).catch(() => undefined);

    const startRes = await runGit(
      ["bisect", "start", manifest.bounds.badSha, manifest.bounds.goodSha],
      worktreePath
    );
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

    const runnerScript = resolveRunnerScriptPath();
    const runRes = await runGit(
      ["bisect", "run", process.execPath, runnerScript, "--session-dir", manifest.sessionDir],
      worktreePath
    );

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
        options
      );
    }

    const abortedEvent = classifiedEvents.find((e) => e.classification === "abort");
    if (abortedEvent || runRes.exitCode >= 128) {
      return this.concludeSession(
        manifest,
        {
          outcome: "aborted",
          skippedShas,
          explanation: abortedEvent
            ? `Bisect aborted at ${abortedEvent.commitSha.slice(0, 8)} (${abortedEvent.reasonCode}): ${abortedEvent.detail}`
            : `git bisect run aborted (exit ${runRes.exitCode}): ${runRes.stderr || runRes.stdout}`,
        },
        options
      );
    }

    const combinedOutput = `${runRes.stdout}\n${bisectLogRes.stdout}`;
    const candidateSha = parseFirstBadShaFromBisectOutput(combinedOutput);

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
          options
        );
      }
      return this.concludeSession(
        manifest,
        {
          outcome: "aborted",
          skippedShas,
          explanation: `Could not parse first bad commit from git bisect output: ${runRes.stdout}`,
        },
        options
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
    });
    const parentConfirm = await runEndpointKTimes({
      manifest,
      target: "candidate_parent",
      commitSha: parentSha,
      runs: confirmRuns,
      abortSignal: options?.abortSignal,
      onEvent: options?.onEvent,
    });

    const confirmed = candConfirm.failed === confirmRuns && parentConfirm.passed === confirmRuns;
    return this.concludeSession(
      manifest,
      {
        outcome: confirmed ? "candidate_confirmed" : "candidate_unconfirmed",
        candidateSha,
        parentSha,
        skippedShas,
        explanation: confirmed
          ? `Confirmed ${candidateSha} as first bad commit (${confirmRuns}/${confirmRuns} bad; parent ${parentSha.slice(0, 8)} ${confirmRuns}/${confirmRuns} good).`
          : `Candidate ${candidateSha} identified by git bisect, but boundary confirmation varied (candidate bad ${candConfirm.failed}/${confirmRuns}, parent good ${parentConfirm.passed}/${confirmRuns}).`,
      },
      options
    );
  }

  private async concludeSession(
    manifest: SessionManifestV1,
    conclusion: SessionConclusion,
    options?: StartSessionOptions
  ): Promise<SessionManifestV1> {
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

    return {
      manifest,
      lockStatus: lockInfo.status,
      ...(lockInfo.holder ? { staleLockHolder: lockInfo.holder } : {}),
      eventCount: events.length,
      ledgerValid: chain.valid,
    };
  }

  async resume(sessionId: string, options?: StartSessionOptions): Promise<SessionManifestV1> {
    const baseDir = path.resolve(process.env.BISECTPILOT_SESSION_ROOT ?? ".bisectpilot/sessions");
    const sessionDir = path.join(baseDir, sessionId);
    let manifest = readSessionManifest(sessionDir);
    manifest = detectCrashNeedsRecovery(manifest, options?.onEvent);

    if (manifest.state !== "needs_recovery" && manifest.state !== "paused") {
      throw new Error(`Session ${sessionId} cannot be resumed from state "${manifest.state}"`);
    }

    await verifyWorktreeOwnership(manifest, manifest.repository.worktreePath);
    if (computeConfigHash(manifest.config) !== manifest.configHash) {
      throw new Error("Session configHash mismatch; refusing to resume tampered session");
    }

    for (const [relPath, expectedHash] of Object.entries(manifest.overlayHashes)) {
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
}
