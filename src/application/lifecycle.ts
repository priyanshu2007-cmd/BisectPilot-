import { existsSync } from "node:fs";
import path from "node:path";
import type {
  CleanupOptions,
  CleanupResult,
  SessionConclusion,
  SessionManifestV1,
  SessionStatusReport,
  StartSessionOptions,
} from "../contracts/index.js";
import { appendLedgerEvent, readLedgerEvents, verifyLedgerFile } from "../ledger/index.js";
import { writeSessionReportArtifacts } from "../reports/index.js";
import {
  detectCrashNeedsRecovery,
  inspectSessionLock,
  listSessionManifests,
  readSessionManifest,
  releaseSessionLock,
  syncCheckpointWithWal,
  transitionSessionState,
  resolveSessionRoot,
  writeSessionManifestAtomic,
} from "../session/index.js";
import { removeOwnedWorktree, verifyWorktreeOwnership } from "../worktree/index.js";

export function cancelSession(
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

export async function concludeSession(
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
  const finalChainHash = events.length > 0 ? events[events.length - 1]!.eventHash : undefined;
  if (finalChainHash) {
    next = { ...next, finalChainHash };
    writeSessionManifestAtomic(next);
  }
  writeSessionReportArtifacts({
    manifest: next,
    events,
    ...(bisectLogText ? { bisectLogText } : {}),
  });

  if (options?.autoCleanup) {
    releaseSessionLock(next.sessionDir);
    await cleanupSession(next.id, { dryRun: false }, path.dirname(next.sessionDir));
    next = readSessionManifest(next.sessionDir);
  }
  return next;
}

export async function cleanupSession(
  sessionId: string,
  options?: CleanupOptions,
  sessionRootDir?: string,
  cwd?: string
): Promise<CleanupResult> {
  const baseDir = await resolveSessionRoot(sessionRootDir, cwd);
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

  const lockInfo = inspectSessionLock(sessionDir);
  if (lockInfo.status === "locked_live") {
    throw new Error(
      `Session ${sessionId} is running (PID ${lockInfo.holder?.pid ?? "unknown"}); stop it first`
    );
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

export async function statusSession(
  sessionId: string,
  sessionRootDir?: string,
  cwd?: string
): Promise<SessionStatusReport> {
  const baseDir = await resolveSessionRoot(sessionRootDir, cwd);
  const sessionDir = path.join(baseDir, sessionId);
  let manifest = readSessionManifest(sessionDir);
  manifest = detectCrashNeedsRecovery(manifest);
  const lockInfo = inspectSessionLock(sessionDir);
  const events = existsSync(manifest.ledgerPath) ? readLedgerEvents(manifest.ledgerPath) : [];
  const chain = verifyLedgerFile(manifest.ledgerPath);

  let checkpointInfo;
  try {
    const cp = syncCheckpointWithWal(sessionDir);
    checkpointInfo = {
      checkpointSeq: cp.checkpointSeq,
      lastWalSeq: cp.lastWalSeq,
      classifiedCount: Object.keys(cp.classifications).length,
      searchPhase: cp.searchPhase,
      resumable:
        lockInfo.status !== "locked_live" &&
        (manifest.state === "needs_recovery" ||
          manifest.state === "paused" ||
          manifest.state === "bisect_running"),
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

export async function listSessions(sessionRootDir?: string, cwd?: string): Promise<readonly SessionManifestV1[]> {
  const baseDir = await resolveSessionRoot(sessionRootDir, cwd);
  return listSessionManifests(baseDir);
}
