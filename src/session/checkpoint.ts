import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  TERMINAL_SESSION_STATES,
  type ClassifiedRevisionRecord,
  type SessionCheckpointV1,
  type SessionConclusion,
} from "../contracts/index.js";
import { readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import { getManifestPath, readSessionManifest } from "./index.js";

export const CHECKPOINT_FILENAME = "checkpoint.json";
export const BACKUP_CHECKPOINT_FILENAME = "checkpoint.backup.json";

export function getCheckpointPath(sessionDir: string): string {
  return path.join(sessionDir, CHECKPOINT_FILENAME);
}

export function getBackupCheckpointPath(sessionDir: string): string {
  return path.join(sessionDir, BACKUP_CHECKPOINT_FILENAME);
}

export function computeCheckpointChecksum(
  checkpointWithoutChecksum: Record<string, unknown>
): string {
  const { checksum: _discarded, ...clean } = checkpointWithoutChecksum;
  const sortedKeys = Object.keys(clean).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    if (clean[k] !== undefined) {
      sortedObj[k] = clean[k];
    }
  }
  return createHash("sha256")
    .update(JSON.stringify(sortedObj))
    .digest("hex");
}

export function validateCheckpointIntegrity(raw: unknown): raw is SessionCheckpointV1 {
  if (!raw || typeof raw !== "object") return false;
  const cp = raw as Record<string, unknown>;
  if (cp.schemaVersion !== 1) return false;
  if (typeof cp.sessionId !== "string" || !cp.sessionId) return false;
  if (typeof cp.checkpointSeq !== "number" || cp.checkpointSeq < 1) return false;
  if (typeof cp.lastWalSeq !== "number" || cp.lastWalSeq < 0) return false;
  if (typeof cp.checksum !== "string") return false;

  const { checksum, ...withoutChecksum } = cp;
  const expectedChecksum = computeCheckpointChecksum(withoutChecksum);
  return expectedChecksum === checksum;
}

export function writeSessionCheckpointAtomic(
  sessionDir: string,
  checkpoint: Omit<SessionCheckpointV1, "checksum"> | SessionCheckpointV1
): SessionCheckpointV1 {
  mkdirSync(sessionDir, { recursive: true });
  const target = getCheckpointPath(sessionDir);
  const backup = getBackupCheckpointPath(sessionDir);

  const { checksum: _discarded, ...payloadWithoutChecksum } = checkpoint as Record<string, unknown>;
  const checksum = computeCheckpointChecksum(payloadWithoutChecksum);
  const completeCheckpoint: SessionCheckpointV1 = {
    ...(payloadWithoutChecksum as unknown as Omit<SessionCheckpointV1, "checksum">),
    checksum,
  };

  if (existsSync(target)) {
    try {
      copyFileSync(target, backup);
    } catch {
      // Ignore backup copy errors
    }
  }

  const tmpPath = path.join(sessionDir, `checkpoint.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(completeCheckpoint, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, target);

  return completeCheckpoint;
}

export function reconstructCheckpointFromWal(sessionDir: string): SessionCheckpointV1 {
  const manifest = readSessionManifest(sessionDir);
  const ledgerPath = manifest.ledgerPath;
  const events = readLedgerEvents(ledgerPath);

  const chainCheck = verifyLedgerChain(events);
  if (!chainCheck.valid) {
    throw new Error(
      `Cannot reconstruct checkpoint: ledger hash chain broken at seq ${chainCheck.brokenAtSeq}: ${chainCheck.reason}`
    );
  }

  let currentState = manifest.state;
  let searchPhase: SessionCheckpointV1["searchPhase"] = "bisect";
  let conclusion: SessionConclusion | undefined = manifest.conclusion;
  const classifications: Record<string, ClassifiedRevisionRecord> = {};
  const testedRevisions: string[] = [];
  let skipCount = 0;
  let lastRecordedRevision: string | undefined = undefined;

  for (const ev of events) {
    if (ev.type === "transition") {
      currentState = ev.to;
      if (ev.to === "preflight_running") searchPhase = "preflight";
      else if (ev.to === "bisect_running") searchPhase = "bisect";
      else if (ev.to === "boundary_verifying") searchPhase = "boundary_check";
      else if (ev.to === "concluded" || TERMINAL_SESSION_STATES.has(ev.to)) searchPhase = "concluded";
    } else if (ev.type === "revision_classified") {
      classifications[ev.commitSha] = {
        commitSha: ev.commitSha,
        classification: ev.classification,
        reasonCode: ev.reasonCode,
        gitExitCode: ev.gitExitCode,
        detail: ev.detail,
        durationMs: undefined,
        noisySampling: ev.noisySampling,
        benchmark: ev.benchmark,
        classifiedAt: ev.timestamp,
      };
      if (!testedRevisions.includes(ev.commitSha)) {
        testedRevisions.push(ev.commitSha);
      }
      if (ev.classification === "skip") {
        skipCount++;
      }
      lastRecordedRevision = ev.commitSha;
    } else if (ev.type === "session_concluded") {
      conclusion = ev.conclusion;
      currentState = "concluded";
      searchPhase = "concluded";
    }
  }

  const checkpointWithoutChecksum: Omit<SessionCheckpointV1, "checksum"> = {
    schemaVersion: 1,
    sessionId: manifest.id,
    checkpointSeq: 1,
    lastWalSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    createdAt: manifest.createdAt,
    updatedAt: new Date().toISOString(),
    state: currentState,
    searchPhase,
    repository: manifest.repository,
    bounds: manifest.bounds,
    configHash: manifest.configHash,
    config: manifest.config,
    overlayHashes: manifest.overlayHashes,
    classifications,
    testedRevisions,
    skipCount,
    lastRecordedRevision,
    conclusion,
    benchmarkBaseline: manifest.benchmarkBaseline,
  };

  return writeSessionCheckpointAtomic(sessionDir, checkpointWithoutChecksum);
}

export function readSessionCheckpoint(sessionDir: string): {
  readonly checkpoint: SessionCheckpointV1;
  readonly source: "primary" | "backup" | "reconstructed_from_wal";
} {
  const target = getCheckpointPath(sessionDir);
  const backup = getBackupCheckpointPath(sessionDir);

  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf-8"));
      if (validateCheckpointIntegrity(parsed)) {
        return { checkpoint: parsed, source: "primary" };
      }
    } catch {
      // Primary corrupted or incomplete write
    }
  }

  if (existsSync(backup)) {
    try {
      const parsed = JSON.parse(readFileSync(backup, "utf-8"));
      if (validateCheckpointIntegrity(parsed)) {
        return { checkpoint: parsed, source: "backup" };
      }
    } catch {
      // Backup corrupted
    }
  }

  const reconstructed = reconstructCheckpointFromWal(sessionDir);
  return { checkpoint: reconstructed, source: "reconstructed_from_wal" };
}

export function syncCheckpointWithWal(sessionDir: string): SessionCheckpointV1 {
  const { checkpoint } = readSessionCheckpoint(sessionDir);
  const manifest = readSessionManifest(sessionDir);
  const events = readLedgerEvents(manifest.ledgerPath);

  if (events.length === 0 || events.length <= checkpoint.lastWalSeq) {
    return checkpoint;
  }

  const newEvents = events.filter((e) => e.seq > checkpoint.lastWalSeq);
  if (newEvents.length === 0) return checkpoint;

  let currentState = checkpoint.state;
  let searchPhase = checkpoint.searchPhase;
  let conclusion = checkpoint.conclusion;
  const classifications = { ...checkpoint.classifications };
  const testedRevisions = [...checkpoint.testedRevisions];
  let skipCount = checkpoint.skipCount;
  let lastRecordedRevision = checkpoint.lastRecordedRevision;

  for (const ev of newEvents) {
    if (ev.type === "transition") {
      currentState = ev.to;
      if (ev.to === "preflight_running") searchPhase = "preflight";
      else if (ev.to === "bisect_running") searchPhase = "bisect";
      else if (ev.to === "boundary_verifying") searchPhase = "boundary_check";
      else if (ev.to === "concluded" || TERMINAL_SESSION_STATES.has(ev.to)) searchPhase = "concluded";
    } else if (ev.type === "revision_classified") {
      classifications[ev.commitSha] = {
        commitSha: ev.commitSha,
        classification: ev.classification,
        reasonCode: ev.reasonCode,
        gitExitCode: ev.gitExitCode,
        detail: ev.detail,
        noisySampling: ev.noisySampling,
        benchmark: ev.benchmark,
        classifiedAt: ev.timestamp,
      };
      if (!testedRevisions.includes(ev.commitSha)) {
        testedRevisions.push(ev.commitSha);
      }
      if (ev.classification === "skip") {
        skipCount++;
      }
      lastRecordedRevision = ev.commitSha;
    } else if (ev.type === "session_concluded") {
      conclusion = ev.conclusion;
      currentState = "concluded";
      searchPhase = "concluded";
    }
  }

  const updated: Omit<SessionCheckpointV1, "checksum"> = {
    ...checkpoint,
    checkpointSeq: checkpoint.checkpointSeq + 1,
    lastWalSeq: events[events.length - 1]!.seq,
    updatedAt: new Date().toISOString(),
    state: currentState,
    searchPhase,
    classifications,
    testedRevisions,
    skipCount,
    lastRecordedRevision,
    conclusion,
  };

  return writeSessionCheckpointAtomic(sessionDir, updated);
}

export function recordRevisionClassificationCheckpoint(
  sessionDir: string,
  record: ClassifiedRevisionRecord,
  walSeq: number
): SessionCheckpointV1 {
  const current = syncCheckpointWithWal(sessionDir);
  const classifications = {
    ...current.classifications,
    [record.commitSha]: record,
  };
  const testedRevisions = current.testedRevisions.includes(record.commitSha)
    ? current.testedRevisions
    : [...current.testedRevisions, record.commitSha];
  const skipCount = record.classification === "skip" ? current.skipCount + 1 : current.skipCount;

  const next: Omit<SessionCheckpointV1, "checksum"> = {
    ...current,
    checkpointSeq: current.checkpointSeq + 1,
    lastWalSeq: Math.max(current.lastWalSeq, walSeq),
    updatedAt: new Date().toISOString(),
    classifications,
    testedRevisions,
    skipCount,
    lastRecordedRevision: record.commitSha,
  };

  return writeSessionCheckpointAtomic(sessionDir, next);
}

export function checkpointToManifest(
  checkpoint: SessionCheckpointV1,
  sessionDir: string,
  ledgerPath: string
): import("../contracts/session.js").SessionManifestV1 {
  return {
    schemaVersion: 1,
    id: checkpoint.sessionId,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    state: checkpoint.state,
    sessionDir,
    ledgerPath,
    repository: checkpoint.repository,
    bounds: checkpoint.bounds,
    configHash: checkpoint.configHash,
    config: checkpoint.config,
    overlayHashes: checkpoint.overlayHashes,
    skipCount: checkpoint.skipCount,
    testedRevisions: checkpoint.testedRevisions,
    lastRecordedRevision: checkpoint.lastRecordedRevision,
    runnerVersion: "0.1.0",
    conclusion: checkpoint.conclusion,
    benchmarkBaseline: checkpoint.benchmarkBaseline,
  };
}
