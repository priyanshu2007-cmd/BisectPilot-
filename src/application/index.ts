import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { computeConfigHash } from "../config/index.js";
import type {
  BisectConfigV1,
  BisectEngine,
  BisectPlanReport,
  CleanupOptions,
  CleanupResult,
  DoctorReport,
  SessionManifestV1,
  SessionStatusReport,
  StartSessionOptions,
} from "../contracts/index.js";
import {
  ensureBisectPilotExcluded,
  getCurrentHead,
  resolveCommonGitDir,
  runGitDoctor,
} from "../git/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import {
  sha256File,
  snapshotExternalScript,
  snapshotOverlayFiles,
} from "../oracle/index.js";
import {
  acquireSessionLock,
  detectCrashNeedsRecovery,
  getLedgerPath,
  readSessionManifest,
  releaseSessionLock,
  resolveSessionRoot,
  syncCheckpointWithWal,
  TERMINAL_SESSION_STATES,
  transitionSessionState,
  writeSessionCheckpointAtomic,
  writeSessionManifestAtomic,
} from "../session/index.js";
import {
  createSessionWorktree,
  verifyWorktreeOwnership,
} from "../worktree/index.js";
import {
  minimizeInput,
  type MinimizeConfig,
  type MinimizeResult,
} from "../domain/minimizer.js";
import type { SandboxRuntimeExecutor } from "../process/index.js";
import {
  createBisectPlan,
  defaultSessionRootDir,
} from "./preflight.js";
import {
  cleanupSession,
  listSessions,
  statusSession,
} from "./lifecycle.js";
import { executeInvestigationFromWorktreeReady } from "./investigation.js";
import { discoverGoodEndpointAndRun } from "./discovery.js";

export * from "./preflight.js";
export * from "./lifecycle.js";
export * from "./investigation.js";
export * from "./discovery.js";

export class LocalBisectEngine implements BisectEngine {
  private readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;

  constructor(options?: { readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor }) {
    this.sandboxRuntimeExecutor = options?.sandboxRuntimeExecutor;
  }

  async doctor(repoPath = "."): Promise<DoctorReport> {
    return runGitDoctor(repoPath);
  }

  async plan(config: BisectConfigV1): Promise<BisectPlanReport> {
    return createBisectPlan(config);
  }

  async start(config: BisectConfigV1, options?: StartSessionOptions): Promise<SessionManifestV1> {
    const planReport = await this.plan(config);
    if (!planReport.ok) {
      throw new Error(`Cannot start bisection plan: ${planReport.warnings.join("; ") || "invalid bounds"}`);
    }
    const sessionId = options?.sessionId ?? `bp-${randomUUID().slice(0, 8)}`;
    const sessionsBase = await resolveSessionRoot(config.sessionRootDir, planReport.repoRoot);
    const sessionDir = path.join(sessionsBase, sessionId);
    const worktreeDir = path.join(sessionDir, "worktree");
    const ledgerPath = getLedgerPath(sessionDir);

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
        return await discoverGoodEndpointAndRun(manifest, planReport, options, this.sandboxRuntimeExecutor);
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
      return await executeInvestigationFromWorktreeReady(manifest, options, this.sandboxRuntimeExecutor);
    } finally {
      if (options?.abortSignal?.aborted) {
        try {
          const m = readSessionManifest(sessionDir);
          if (m.state === "bisect_running") {
            transitionSessionState(m, "paused", "interrupted by signal", options?.onEvent);
          }
        } catch {
          // ignore
        }
      }
      releaseSessionLock(sessionDir);
    }
  }

  async status(sessionId: string, sessionRootDir?: string, cwd?: string): Promise<SessionStatusReport> {
    return statusSession(sessionId, sessionRootDir, cwd);
  }

  async resume(
    sessionId: string,
    options?: StartSessionOptions,
    sessionRootDir?: string,
    cwd?: string
  ): Promise<SessionManifestV1> {
    const baseDir = await resolveSessionRoot(sessionRootDir, cwd);
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
      return await executeInvestigationFromWorktreeReady(
        manifest,
        {
          ...options,
          skipPreflight: true,
        },
        this.sandboxRuntimeExecutor
      );
    } finally {
      if (options?.abortSignal?.aborted) {
        try {
          const m = readSessionManifest(sessionDir);
          if (m.state === "bisect_running") {
            transitionSessionState(m, "paused", "interrupted by signal", options?.onEvent);
          }
        } catch {
          // ignore
        }
      }
      releaseSessionLock(sessionDir);
    }
  }

  async cleanup(
    sessionId: string,
    options?: CleanupOptions,
    sessionRootDir?: string,
    cwd?: string
  ): Promise<CleanupResult> {
    return cleanupSession(sessionId, options, sessionRootDir, cwd);
  }

  async list(sessionRootDir?: string, cwd?: string): Promise<readonly SessionManifestV1[]> {
    return listSessions(sessionRootDir, cwd);
  }

  async minimize(config: MinimizeConfig): Promise<MinimizeResult> {
    return minimizeInput(config);
  }
}
