import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  computeCheckpointChecksum,
  getBackupCheckpointPath,
  getCheckpointPath,
  readSessionCheckpoint,
  reconstructCheckpointFromWal,
  recordRevisionClassificationCheckpoint,
  syncCheckpointWithWal,
  validateCheckpointIntegrity,
  writeSessionCheckpointAtomic,
  writeSessionManifestAtomic,
  type SessionCheckpointV1,
  type SessionManifestV1,
} from "../../src/session/index.js";
import { appendLedgerEvent, verifyLedgerChain } from "../../src/ledger/index.js";
import { mannWhitneyUTest } from "../../src/domain/statistics.js";

function createTmpDir(): string {
  const dir = path.join(os.tmpdir(), `bisectpilot-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("Session Checkpoint & WAL Recovery Suite", async (t) => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  await t.test("writeSessionCheckpointAtomic writes checkpoint.json and backup.json atomically", () => {
    const sessionDir = path.join(tmpDir, "session_test_1");
    mkdirSync(sessionDir, { recursive: true });

    const cp1: Omit<SessionCheckpointV1, "checksum"> = {
      schemaVersion: 1,
      sessionId: "session_test_1",
      checkpointSeq: 1,
      lastWalSeq: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      searchPhase: "bisect",
      repository: {
        rootPath: "/mock/repo",
        commonGitDir: "/mock/repo/.git",
        originalHead: "badsha0001",
        originalWasDirty: false,
        worktreePath: "/mock/worktree",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "v1.0",
        goodSha: "goodsha0001",
        badInputRef: "main",
        badSha: "badsha0001",
      },
      configHash: "cfghash123",
      config: {
        command: "npm test",
        args: [],
        goodRef: "goodsha0001",
        badRef: "badsha0001",
      } as any,
      overlayHashes: {},
      classifications: {},
      testedRevisions: [],
      skipCount: 0,
    };

    const written1 = writeSessionCheckpointAtomic(sessionDir, cp1);
    assert.equal(written1.checkpointSeq, 1);
    assert.ok(written1.checksum);
    assert.ok(existsSync(getCheckpointPath(sessionDir)));

    // Writing seq 2 preserves seq 1 as backup
    const cp2: Omit<SessionCheckpointV1, "checksum"> = {
      ...cp1,
      checkpointSeq: 2,
      lastWalSeq: 2,
      classifications: {
        midsha0001: {
          commitSha: "midsha0001",
          classification: "good",
          reasonCode: "oracle_passed",
          gitExitCode: 0,
          detail: "passed",
          classifiedAt: "2026-10-20T10:01:00.000Z",
        },
      },
      testedRevisions: ["midsha0001"],
    };

    const written2 = writeSessionCheckpointAtomic(sessionDir, cp2);
    assert.equal(written2.checkpointSeq, 2);
    assert.ok(existsSync(getBackupCheckpointPath(sessionDir)));

    const backupContent = JSON.parse(readFileSync(getBackupCheckpointPath(sessionDir), "utf-8"));
    assert.equal(backupContent.checkpointSeq, 1);
  });

  await t.test("validateCheckpointIntegrity rejects corrupted checksum or modified fields", () => {
    const validCp: Omit<SessionCheckpointV1, "checksum"> = {
      schemaVersion: 1,
      sessionId: "session_123",
      checkpointSeq: 1,
      lastWalSeq: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      searchPhase: "bisect",
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "h1",
        originalWasDirty: false,
        worktreePath: "/wt",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "good",
        goodSha: "g1",
        badInputRef: "bad",
        badSha: "b1",
      },
      configHash: "h",
      config: {} as any,
      overlayHashes: {},
      classifications: {},
      testedRevisions: [],
      skipCount: 0,
    };

    const checksum = computeCheckpointChecksum(validCp);
    const complete: SessionCheckpointV1 = { ...validCp, checksum };
    assert.ok(validateCheckpointIntegrity(complete));

    // Corrupted checksum
    assert.equal(validateCheckpointIntegrity({ ...complete, checksum: "bad_checksum" }), false);

    // Tampered payload
    assert.equal(validateCheckpointIntegrity({ ...complete, state: "concluded" }), false);
  });

  await t.test("readSessionCheckpoint falls back to backup when primary is corrupted", () => {
    const sessionDir = path.join(tmpDir, "session_fallback");
    mkdirSync(sessionDir, { recursive: true });

    const baseCp: Omit<SessionCheckpointV1, "checksum"> = {
      schemaVersion: 1,
      sessionId: "session_fallback",
      checkpointSeq: 1,
      lastWalSeq: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      searchPhase: "bisect",
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "h1",
        originalWasDirty: false,
        worktreePath: "/wt",
        createdByTool: true,
      },
      bounds: { goodInputRef: "g", goodSha: "g1", badInputRef: "b", badSha: "b1" },
      configHash: "h",
      config: {} as any,
      overlayHashes: {},
      classifications: {},
      testedRevisions: [],
      skipCount: 0,
    };

    // Write seq 1, then seq 2
    writeSessionCheckpointAtomic(sessionDir, baseCp);
    writeSessionCheckpointAtomic(sessionDir, { ...baseCp, checkpointSeq: 2, lastWalSeq: 2 });

    // Corrupt primary checkpoint.json (simulating crash mid-write)
    writeFileSync(getCheckpointPath(sessionDir), "{ truncated json...", "utf-8");

    const read = readSessionCheckpoint(sessionDir);
    assert.equal(read.source, "backup");
    assert.equal(read.checkpoint.checkpointSeq, 1);
  });

  await t.test("reconstructCheckpointFromWal recreates authoritative state from events.jsonl", () => {
    const sessionDir = path.join(tmpDir, "session_wal_reconstruct");
    const ledgerPath = path.join(sessionDir, "events.jsonl");
    mkdirSync(sessionDir, { recursive: true });

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_wal_reconstruct",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "head1",
        originalWasDirty: false,
        worktreePath: "/repo/.bisectpilot/worktree",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "good",
        goodSha: "good1111",
        badInputRef: "bad",
        badSha: "bad1111",
      },
      configHash: "cfghash",
      config: { command: "test", args: [] } as any,
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [],
      runnerVersion: "0.1.0",
    };
    writeSessionManifestAtomic(manifest);

    // Append WAL events
    appendLedgerEvent(ledgerPath, {
      type: "session_created",
      sessionId: manifest.id,
      goodSha: manifest.bounds.goodSha,
      badSha: manifest.bounds.badSha,
      worktreePath: manifest.repository.worktreePath,
      overlayHashes: {},
    });

    appendLedgerEvent(ledgerPath, {
      type: "transition",
      sessionId: manifest.id,
      from: "created",
      to: "bisect_running",
    });

    appendLedgerEvent(ledgerPath, {
      type: "revision_classified",
      sessionId: manifest.id,
      commitSha: "sha_mid_1",
      classification: "good",
      reasonCode: "oracle_passed",
      detail: "exit 0",
      gitExitCode: 0,
      overlayHashes: {},
    });

    appendLedgerEvent(ledgerPath, {
      type: "revision_classified",
      sessionId: manifest.id,
      commitSha: "sha_mid_2",
      classification: "bad",
      reasonCode: "oracle_failed_expected_regression",
      detail: "exit 1",
      gitExitCode: 1,
      overlayHashes: {},
    });

    // Reconstruct checkpoint from WAL
    const cp = reconstructCheckpointFromWal(sessionDir);
    assert.equal(cp.sessionId, manifest.id);
    assert.equal(cp.state, "bisect_running");
    assert.equal(cp.lastWalSeq, 4);
    assert.equal(Object.keys(cp.classifications).length, 2);
    assert.equal(cp.classifications["sha_mid_1"]?.classification, "good");
    assert.equal(cp.classifications["sha_mid_2"]?.classification, "bad");
    assert.deepEqual(cp.testedRevisions, ["sha_mid_1", "sha_mid_2"]);
  });

  await t.test("syncCheckpointWithWal updates checkpoint with new WAL records idempotently", () => {
    const sessionDir = path.join(tmpDir, "session_wal_sync");
    const ledgerPath = path.join(sessionDir, "events.jsonl");
    mkdirSync(sessionDir, { recursive: true });

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_wal_sync",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "head1",
        originalWasDirty: false,
        worktreePath: "/repo/.bisectpilot/worktree",
        createdByTool: true,
      },
      bounds: { goodInputRef: "good", goodSha: "good1", badInputRef: "bad", badSha: "bad1" },
      configHash: "h",
      config: {} as any,
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [],
      runnerVersion: "0.1.0",
    };
    writeSessionManifestAtomic(manifest);

    appendLedgerEvent(ledgerPath, {
      type: "session_created",
      sessionId: manifest.id,
      goodSha: manifest.bounds.goodSha,
      badSha: manifest.bounds.badSha,
      worktreePath: manifest.repository.worktreePath,
      overlayHashes: {},
    });

    // Write initial checkpoint at WAL seq 1
    const cp1 = reconstructCheckpointFromWal(sessionDir);
    assert.equal(cp1.lastWalSeq, 1);

    // Append revision classified event
    appendLedgerEvent(ledgerPath, {
      type: "revision_classified",
      sessionId: manifest.id,
      commitSha: "sha_new_1",
      classification: "skip",
      reasonCode: "untestable_revision",
      detail: "exit 125",
      gitExitCode: 125,
      overlayHashes: {},
    });

    // Sync checkpoint
    const synced = syncCheckpointWithWal(sessionDir);
    assert.equal(synced.lastWalSeq, 2);
    assert.equal(synced.skipCount, 1);
    assert.ok(synced.classifications["sha_new_1"]);
    assert.equal(synced.classifications["sha_new_1"]?.gitExitCode, 125);

    // Re-syncing when no new events exist is idempotent
    const reSynced = syncCheckpointWithWal(sessionDir);
    assert.equal(reSynced.checkpointSeq, synced.checkpointSeq);
    assert.equal(reSynced.lastWalSeq, 2);
  });

  await t.test("recordRevisionClassificationCheckpoint increments sequence and records record", () => {
    const sessionDir = path.join(tmpDir, "session_record_test");
    const ledgerPath = path.join(sessionDir, "events.jsonl");
    mkdirSync(sessionDir, { recursive: true });

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_record_test",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "head1",
        originalWasDirty: false,
        worktreePath: "/repo/worktree",
        createdByTool: true,
      },
      bounds: { goodInputRef: "good", goodSha: "good1", badInputRef: "bad", badSha: "bad1" },
      configHash: "h",
      config: {} as any,
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [],
      runnerVersion: "0.1.0",
    };
    writeSessionManifestAtomic(manifest);
    appendLedgerEvent(ledgerPath, {
      type: "session_created",
      sessionId: manifest.id,
      goodSha: manifest.bounds.goodSha,
      badSha: manifest.bounds.badSha,
      worktreePath: manifest.repository.worktreePath,
      overlayHashes: {},
    });

    const updated = recordRevisionClassificationCheckpoint(
      sessionDir,
      {
        commitSha: "sha_classified_1",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        gitExitCode: 1,
        detail: "test failed",
        classifiedAt: "2026-10-20T10:05:00.000Z",
      },
      2
    );

    assert.equal(updated.classifications["sha_classified_1"]?.classification, "bad");
    assert.equal(updated.classifications["sha_classified_1"]?.gitExitCode, 1);
    assert.equal(updated.lastRecordedRevision, "sha_classified_1");
  });

  await t.test("mannWhitneyUTest calculates rank sums, U statistics, and p-values correctly", () => {
    // 1. Identical distributions -> pValue = 1.0
    const resIdentical = mannWhitneyUTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    assert.equal(resIdentical.u1, 12.5);
    assert.equal(resIdentical.u2, 12.5);
    assert.ok(resIdentical.pValue > 0.95);

    // 2. Clear difference (candidate is significantly higher)
    const baseline = [10, 11, 12, 10.5, 11.2, 10.8, 11.1, 10.9];
    const candidate = [25, 26, 27, 25.5, 26.2, 25.8, 26.1, 25.9];
    const resDiff = mannWhitneyUTest(baseline, candidate);
    assert.equal(resDiff.uStatistic, 0); // all candidate ranks > baseline
    assert.ok(resDiff.pValue < 0.001);

    // 3. Handles empty input safely
    const resEmpty = mannWhitneyUTest([], [1, 2]);
    assert.equal(resEmpty.pValue, 1.0);
    assert.equal(resEmpty.uStatistic, 0);
  });
});
