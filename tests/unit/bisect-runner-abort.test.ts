import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  readSessionCheckpoint,
  reconstructCheckpointFromWal,
  recordRevisionClassificationCheckpoint,
  syncCheckpointWithWal,
  writeSessionCheckpointAtomic,
  writeSessionManifestAtomic,
  type SessionManifestV1,
} from "../../src/session/index.js";
import { appendLedgerEvent } from "../../src/ledger/index.js";
import { executeSingleBisectStep } from "../../src/runner/bisect-runner.js";
import { buildFixtureRepo, type GeneratedFixtureRepo } from "../fixtures/repo-builder.js";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1, type CommandSpec } from "../../src/contracts/config.js";

function createTmpDir(): string {
  const dir = path.join(os.tmpdir(), `bp-runner-abort-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTestConfig(repoDir: string, commandSpec?: CommandSpec): BisectConfigV1 {
  return {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: repoDir,
    workingDirectory: ".",
    goodRef: "v1.0",
    badRef: "main",
    oracle: {
      mode: "in-tree",
      command: commandSpec ?? {
        command: "node",
        args: ["-e", "process.exit(0)"],
        timeoutMs: 5000,
      },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      confirmBeforeExecutingCode: false,
    },
  };
}

test("Bisect Runner Abort and Classification Caching Suite", async (t) => {
  let tmpDir: string;
  let fixture: GeneratedFixtureRepo | undefined;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  await t.test("recordRevisionClassificationCheckpoint does not cache abort in classifications", () => {
    const sessionDir = path.join(tmpDir, "session_abort_cache");
    mkdirSync(sessionDir, { recursive: true });
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");

    const config = makeTestConfig("/repo");
    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_abort_cache",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "sha001",
        originalWasDirty: false,
        worktreePath: "/repo/wt",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "v1.0",
        goodSha: "sha_good",
        badInputRef: "main",
        badSha: "sha_bad",
      },
      configHash: "hash123",
      config,
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

    writeSessionCheckpointAtomic(sessionDir, {
      schemaVersion: 1,
      sessionId: manifest.id,
      checkpointSeq: 1,
      lastWalSeq: 1,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      state: "bisect_running",
      searchPhase: "bisect",
      repository: manifest.repository,
      bounds: manifest.bounds,
      configHash: manifest.configHash,
      config: manifest.config,
      overlayHashes: {},
      classifications: {},
      testedRevisions: [],
      skipCount: 0,
    });

    recordRevisionClassificationCheckpoint(
      sessionDir,
      {
        commitSha: "sha_abort_1",
        classification: "abort",
        reasonCode: "cancelled",
        gitExitCode: 128,
        detail: "Interrupted by signal",
        classifiedAt: new Date().toISOString(),
      },
      2
    );

    const { checkpoint } = readSessionCheckpoint(sessionDir);
    assert.strictEqual(
      checkpoint.classifications["sha_abort_1"],
      undefined,
      "Abort outcome must not be stored in checkpoint.classifications"
    );
  });

  await t.test("syncCheckpointWithWal and reconstructCheckpointFromWal do not store abort in classifications", () => {
    const sessionDir = path.join(tmpDir, "session_wal_abort");
    mkdirSync(sessionDir, { recursive: true });
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");

    const config = makeTestConfig("/repo");
    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_wal_abort",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository: {
        rootPath: "/repo",
        commonGitDir: "/repo/.git",
        originalHead: "sha001",
        originalWasDirty: false,
        worktreePath: "/repo/wt",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "v1.0",
        goodSha: "sha_good",
        badInputRef: "main",
        badSha: "sha_bad",
      },
      configHash: "hash123",
      config,
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

    appendLedgerEvent(ledgerPath, {
      type: "revision_classified",
      sessionId: manifest.id,
      commitSha: "sha_abort_2",
      classification: "abort",
      reasonCode: "cancelled",
      detail: "Process killed",
      gitExitCode: 128,
      overlayHashes: {},
      classifiedBy: "automated",
    });

    const reconstructed = reconstructCheckpointFromWal(sessionDir);
    assert.strictEqual(
      reconstructed.classifications["sha_abort_2"],
      undefined,
      "reconstructCheckpointFromWal must not store abort in classifications"
    );

    writeSessionCheckpointAtomic(sessionDir, {
      schemaVersion: 1,
      sessionId: manifest.id,
      checkpointSeq: 1,
      lastWalSeq: 1,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      state: "bisect_running",
      searchPhase: "bisect",
      repository: manifest.repository,
      bounds: manifest.bounds,
      configHash: manifest.configHash,
      config: manifest.config,
      overlayHashes: {},
      classifications: {},
      testedRevisions: [],
      skipCount: 0,
    });

    const synced = syncCheckpointWithWal(sessionDir);
    assert.strictEqual(
      synced.classifications["sha_abort_2"],
      undefined,
      "syncCheckpointWithWal must not store abort in classifications"
    );
  });

  await t.test("executeSingleBisectStep aborts and kills child process group when abortSignal fires", async () => {
    fixture = await buildFixtureRepo([
      { message: "Initial commit", files: { "file.txt": "v1" } },
      { message: "Commit 2", files: { "file.txt": "v2" } },
    ]);

    const sessionDir = path.join(tmpDir, "session_runner_abort");
    mkdirSync(sessionDir, { recursive: true });
    const ledgerPath = path.join(sessionDir, "ledger.jsonl");

    const wtDir = path.join(tmpDir, "tool_wt");
    const { createSessionWorktree } = await import("../../src/adapters/git/worktree-manager.js");
    const repository = await createSessionWorktree({
      sessionId: "session_runner_abort",
      repoRoot: fixture.repoDir,
      commonGitDir: path.join(fixture.repoDir, ".git"),
      originalHead: fixture.commitShas[1]!,
      originalWasDirty: false,
      worktreePath: wtDir,
      initialCommitSha: fixture.commitShas[1]!,
    });

    const markerFile = path.join(tmpDir, "sleep_marker.pid");
    // Script writes its child PID to markerFile, then sleeps
    const script =
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
    const config = makeTestConfig(fixture.repoDir, {
      command: process.execPath,
      args: ["-e", script, markerFile],
      timeoutMs: 15000,
    });

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_runner_abort",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "bisect_running",
      sessionDir,
      ledgerPath,
      repository,
      bounds: {
        goodInputRef: fixture.commitShas[0]!,
        goodSha: fixture.commitShas[0]!,
        badInputRef: fixture.commitShas[1]!,
        badSha: fixture.commitShas[1]!,
      },
      configHash: "hash123",
      config: {
        ...config,
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[1]!,
      },
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

    const ac = new AbortController();

    // Start executeSingleBisectStep
    const stepPromise = executeSingleBisectStep(sessionDir, ac.signal);

    // Wait until child is running (marker file exists)
    let childPid: number | undefined;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(markerFile, "utf-8").trim();
        if (content) {
          childPid = parseInt(content, 10);
          break;
        }
      } catch {
        // Not created yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(childPid, "Child process must have started and written marker");

    // Abort runner
    ac.abort();

    const exitCode = await stepPromise;
    assert.strictEqual(exitCode, 128, "Runner must return 128 on abort");

    // Verify child process group is gone within grace period (~1s)
    let processAlive = true;
    const checkStart = Date.now();
    while (Date.now() - checkStart < 3000) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        processAlive = false;
        break;
      }
    }
    assert.strictEqual(processAlive, false, "Child process group must be killed on abort");

    // Verify checkpoint classifications does NOT have this commit
    const { checkpoint } = readSessionCheckpoint(sessionDir);
    assert.strictEqual(
      checkpoint.classifications[fixture.commitShas[1]!],
      undefined,
      "Aborted commit must not be cached in classifications"
    );
  });
});
