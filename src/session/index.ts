import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommonGitDir } from "../adapters/git/git-client.js";
import {
  isValidStateTransition,
  TERMINAL_SESSION_STATES,
  type LedgerEvent,
  type SessionLockMetadata,
  type SessionManifestV1,
  type SessionState,
} from "../contracts/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import { defaultMetrics } from "../telemetry/index.js";
import {
  checkpointToManifest,
  getCheckpointPath,
  readSessionCheckpoint,
  syncCheckpointWithWal,
} from "./checkpoint.js";

export * from "../contracts/session.js";
export * from "./checkpoint.js";

const MANIFEST_FILENAME = "manifest.json";
const LOCK_FILENAME = "session.lock";
export const LEDGER_FILENAME = "ledger.jsonl";

export async function resolveSessionRoot(
  explicit?: string,
  cwd: string = process.cwd()
): Promise<string> {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const env = process.env.BISECTPILOT_SESSION_ROOT;
  if (env && env.trim()) {
    return path.resolve(env.trim());
  }
  try {
    const commonGitDir = await resolveCommonGitDir(cwd);
    const repoRoot = path.basename(commonGitDir) === ".git" ? path.dirname(commonGitDir) : commonGitDir;
    return path.resolve(repoRoot, ".bisectpilot", "sessions");
  } catch {
    return path.resolve(cwd, ".bisectpilot", "sessions");
  }
}

export function getLedgerPath(sessionDir: string): string {
  return path.join(sessionDir, LEDGER_FILENAME);
}

export function getManifestPath(sessionDir: string): string {
  return path.join(sessionDir, MANIFEST_FILENAME);
}

export function getLockPath(sessionDir: string): string {
  return path.join(sessionDir, LOCK_FILENAME);
}

export function writeSessionManifestAtomic(manifest: SessionManifestV1): void {
  mkdirSync(manifest.sessionDir, { recursive: true });
  const target = getManifestPath(manifest.sessionDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  renameSync(tmp, target);
}

export function readSessionManifest(sessionDir: string): SessionManifestV1 {
  const target = getManifestPath(sessionDir);
  if (!existsSync(target)) {
    try {
      const { checkpoint } = readSessionCheckpoint(sessionDir);
      const ledgerPath = getLedgerPath(sessionDir);
      const reconstructed = checkpointToManifest(checkpoint, sessionDir, ledgerPath);
      writeSessionManifestAtomic(reconstructed);
      return reconstructed;
    } catch {
      throw new Error(`Session manifest not found at ${target}`);
    }
  }
  try {
    let parsed = JSON.parse(readFileSync(target, "utf-8")) as SessionManifestV1;
    if (parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || !parsed.repository?.worktreePath) {
      throw new Error(`Invalid or corrupted session manifest at ${target}`);
    }
    if (
      typeof parsed.ledgerPath === "string" &&
      parsed.ledgerPath.endsWith("events.jsonl") &&
      !existsSync(parsed.ledgerPath)
    ) {
      const correctLedgerPath = getLedgerPath(sessionDir);
      if (existsSync(correctLedgerPath)) {
        parsed = {
          ...parsed,
          ledgerPath: correctLedgerPath,
        };
        try {
          writeSessionManifestAtomic(parsed);
        } catch {
          // ignore write errors
        }
      }
    }
    return parsed;
  } catch (err) {
    try {
      const { checkpoint } = readSessionCheckpoint(sessionDir);
      const ledgerPath = getLedgerPath(sessionDir);
      const reconstructed = checkpointToManifest(checkpoint, sessionDir, ledgerPath);
      writeSessionManifestAtomic(reconstructed);
      return reconstructed;
    } catch {
      throw err;
    }
  }
}

/**
 * Central state-transition function (Section 27.2).
 * Rejects illegal transitions and persists both the ledger event and manifest BEFORE side effects.
 */
export function transitionSessionState(
  manifest: SessionManifestV1,
  to: SessionState,
  reason?: string,
  onEvent?: (event: LedgerEvent) => void
): SessionManifestV1 {
  if (!isValidStateTransition(manifest.state, to)) {
    throw new Error(`Illegal session state transition: ${manifest.state} -> ${to}`);
  }

  appendLedgerEvent(
    manifest.ledgerPath,
    {
      type: "transition",
      sessionId: manifest.id,
      from: manifest.state,
      to,
      ...(reason ? { reason } : {}),
    },
    onEvent
  );

  const updated: SessionManifestV1 = {
    ...manifest,
    state: to,
    updatedAt: new Date().toISOString(),
  };
  writeSessionManifestAtomic(updated);

  try {
    if (existsSync(getCheckpointPath(manifest.sessionDir))) {
      syncCheckpointWithWal(manifest.sessionDir);
    }
  } catch {
    // Checkpoint sync failure does not compromise ledger or manifest
  }

  if (manifest.state === "created" && to !== "created" && !TERMINAL_SESSION_STATES.has(to) && to !== "concluded") {
    defaultMetrics.activeSessions.inc();
  } else if (!TERMINAL_SESSION_STATES.has(manifest.state) && manifest.state !== "concluded" && (TERMINAL_SESSION_STATES.has(to) || to === "concluded")) {
    defaultMetrics.activeSessions.dec();
  }

  if (to === "needs_recovery") {
    defaultMetrics.recoveryRequiredSessionsTotal.inc();
  }
  if (to === "cancelled") {
    defaultMetrics.cancellationsTotal.inc({ scope: "session" });
  }

  return updated;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function inspectSessionLock(sessionDir: string): {
  readonly status: "unlocked" | "locked_live" | "locked_stale";
  readonly holder?: SessionLockMetadata;
} {
  const lockPath = getLockPath(sessionDir);
  if (!existsSync(lockPath)) {
    return { status: "unlocked" };
  }
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf-8")) as SessionLockMetadata;
    const sameHost = holder.hostname === os.hostname();
    if (sameHost && isPidAlive(holder.pid)) {
      return { status: "locked_live", holder };
    }
    return { status: "locked_stale", holder };
  } catch {
    return { status: "locked_stale" };
  }
}

export function acquireSessionLock(sessionDir: string): SessionLockMetadata {
  mkdirSync(sessionDir, { recursive: true });
  const current = inspectSessionLock(sessionDir);
  if (current.status === "locked_live") {
    throw new Error(
      `Session is currently locked by active PID ${current.holder?.pid} on ${current.holder?.hostname}`
    );
  }
  if (current.status === "locked_stale") {
    throw new Error(
      `Stale session lock detected (PID ${current.holder?.pid ?? "unknown"}); inspect with status or run resume/cleanup`
    );
  }
  const metadata: SessionLockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(getLockPath(sessionDir), JSON.stringify(metadata, null, 2) + "\n", {
    encoding: "utf-8",
    flag: "wx",
  });
  return metadata;
}

export function releaseSessionLock(sessionDir: string, clearStale = false): void {
  const lockPath = getLockPath(sessionDir);
  if (!existsSync(lockPath)) return;
  if (!clearStale) {
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf-8")) as SessionLockMetadata;
      if (holder.pid !== process.pid) return;
    } catch {
      return;
    }
  }
  rmSync(lockPath, { force: true });
}

export function detectCrashNeedsRecovery(
  manifest: SessionManifestV1,
  onEvent?: (event: LedgerEvent) => void
): SessionManifestV1 {
  if (TERMINAL_SESSION_STATES.has(manifest.state) || manifest.state === "concluded" || manifest.state === "needs_recovery") {
    return manifest;
  }
  const lockInfo = inspectSessionLock(manifest.sessionDir);
  if (lockInfo.status === "locked_stale") {
    return transitionSessionState(
      manifest,
      "needs_recovery",
      `Detected non-terminal state "${manifest.state}" with stale lock from dead PID ${lockInfo.holder?.pid ?? "unknown"}`,
      onEvent
    );
  }
  if (manifest.state === "bisect_running" && lockInfo.status === "unlocked") {
    return transitionSessionState(
      manifest,
      "needs_recovery",
      `Detected state "bisect_running" with no live lock; recovery required`,
      onEvent
    );
  }
  return manifest;
}

export function listSessionManifests(sessionRootDir: string): SessionManifestV1[] {
  if (!existsSync(sessionRootDir)) return [];
  const entries = readdirSync(sessionRootDir, { withFileTypes: true });
  const manifests: SessionManifestV1[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionRootDir, entry.name);
    if (existsSync(getManifestPath(dir))) {
      try {
        manifests.push(readSessionManifest(dir));
      } catch {
        // Ignore unreadable partial directories
      }
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
