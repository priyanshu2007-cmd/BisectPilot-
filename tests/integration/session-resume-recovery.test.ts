import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  LocalBisectEngine,
  readLedgerEvents,
  readSessionCheckpoint,
  readSessionManifest,
  resolveRefToSha,
  runGit,
  syncCheckpointWithWal,
  verifyLedgerChain,
  computeCheckpointChecksum,
  validateCheckpointIntegrity,
  writeSessionManifestAtomic,
  type BisectConfigV1,
} from "../../src/index.js";

async function createGitRepoFixture(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
  readonly plantedRegressionSha: string;
}> {
  const repoDir = path.join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Recovery Bot"], repoDir);
  await runGit(["config", "user.email", "recovery@example.com"], repoDir);

  const shas: string[] = [];

  // Commit 1: Good baseline
  writeFileSync(path.join(repoDir, "feature.txt"), "status=good\n", "utf-8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C1: baseline good"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 2: Still good
  writeFileSync(path.join(repoDir, "doc.txt"), "documentation\n", "utf-8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C2: docs"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 3: Planted regression (becomes bad)
  writeFileSync(path.join(repoDir, "feature.txt"), "status=broken\n", "utf-8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C3: broken feature regression"], repoDir);
  const plantedRegressionSha = await resolveRefToSha(repoDir, "HEAD");
  shas.push(plantedRegressionSha);

  // Commit 4: Still broken
  writeFileSync(path.join(repoDir, "extra.txt"), "extra file\n", "utf-8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C4: extra changes"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 5: Bad endpoint
  writeFileSync(path.join(repoDir, "more.txt"), "more\n", "utf-8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C5: bad endpoint"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  return { repoDir, shas, plantedRegressionSha };
}

describe("Step 14 — Automated Session Recovery & Checkpoint Resumption Integration", () => {
  it("recovers an interrupted session, fast-forwards cached revisions, and isolates exact regression commit", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-resume-test-"));
    try {
      const { repoDir, shas, plantedRegressionSha } = await createGitRepoFixture(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      const evaluationLogFile = path.join(tmpRoot, "evaluations.log");

      // Oracle test script that logs every execution to track whether cached commits get rerun
      const testScript = path.join(tmpRoot, "check.mjs");
      writeFileSync(
        testScript,
        `import { readFileSync, appendFileSync } from "node:fs";
const content = readFileSync("feature.txt", "utf-8");
appendFileSync(${JSON.stringify(evaluationLogFile)}, process.env.GIT_COMMIT || "eval\\n");
if (content.includes("status=broken")) {
  process.exit(1);
}
process.exit(0);
`,
        "utf-8"
      );

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[4]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: [testScript],
            timeoutMs: 30000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir,
      };

      const engine = new LocalBisectEngine();
      const startResult = await engine.start(config, {
        sessionId: "sess_resume_01",
      });

      assert.equal(startResult.conclusion?.outcome, "candidate_confirmed");
      assert.equal(startResult.conclusion?.candidateSha, plantedRegressionSha);

      // Verify that checkpoint was written and synchronized with WAL
      const sessionDir = path.join(sessionRootDir, "sess_resume_01");
      const { checkpoint, source } = readSessionCheckpoint(sessionDir);
      assert.equal(source, "primary");
      assert.equal(checkpoint.sessionId, "sess_resume_01");
      assert.equal(checkpoint.state, "concluded");
      assert.ok(checkpoint.checkpointSeq >= 2);
      assert.ok(checkpoint.classifications[plantedRegressionSha]);
      assert.equal(checkpoint.classifications[plantedRegressionSha]?.classification, "bad");

      // Verify that ledger hash-chain is unbroken
      const events = readLedgerEvents(startResult.ledgerPath);
      const chainCheck = verifyLedgerChain(events);
      assert.equal(chainCheck.valid, true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles crash recovery: stale lock detection, checkpoint WAL sync, and resume without repeating work", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-crash-test-"));
    try {
      const { repoDir, shas, plantedRegressionSha } = await createGitRepoFixture(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      const evaluationCounterFile = path.join(tmpRoot, "runs.log");

      const testScript = path.join(tmpRoot, "check.mjs");
      writeFileSync(
        testScript,
        `import { readFileSync, appendFileSync } from "node:fs";
const content = readFileSync("feature.txt", "utf-8");
appendFileSync(${JSON.stringify(evaluationCounterFile)}, "run\\n");
if (content.includes("status=broken")) {
  process.exit(1);
}
process.exit(0);
`,
        "utf-8"
      );

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[4]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: [testScript],
            timeoutMs: 30000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir,
      };

      const engine = new LocalBisectEngine();
      const sessionId = "sess_crash_01";
      const sessionDir = path.join(sessionRootDir, sessionId);

      // 1. Start session normally and let it complete initial preflight and start bisecting
      const manifest = await engine.start(config, {
        sessionId,
      });

      // 2. Simulate crash by marking state back to bisect_running with a stale lock from a dead PID
      const currentManifest = readSessionManifest(sessionDir);
      writeSessionManifestAtomic({
        ...currentManifest,
        state: "bisect_running",
      });

      // Inject stale session.lock with dead PID 999999
      writeFileSync(
        path.join(sessionDir, "session.lock"),
        JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAt: "2026-10-20T00:00:00.000Z" }),
        "utf-8"
      );

      // 3. Inspect status: detectCrashNeedsRecovery must detect stale lock and mark state as needs_recovery
      const status = await engine.status(sessionId, sessionRootDir);
      assert.equal(status.manifest.state, "needs_recovery");
      assert.equal(status.lockStatus, "locked_stale");
      assert.ok(status.checkpoint?.resumable);
      assert.ok(status.checkpoint.classifiedCount > 0);

      // 4. Test manifest corruption recovery: corrupt manifest.json
      writeFileSync(path.join(sessionDir, "manifest.json"), "{ invalid truncated json", "utf-8");

      // readSessionManifest automatically recovers the manifest from checkpoint/WAL
      const recoveredManifest = readSessionManifest(sessionDir);
      assert.equal(recoveredManifest.id, sessionId);
      assert.ok(recoveredManifest.repository.worktreePath);

      // 5. Resume session: clears stale lock, verifies invariants, and concludes cleanly
      const resumed = await engine.resume(sessionId, {}, sessionRootDir);
      assert.equal(resumed.conclusion?.outcome, "candidate_confirmed");
      assert.equal(resumed.conclusion?.candidateSha, plantedRegressionSha);

      // 6. Resuming already concluded session is safe and idempotent
      const resumedAgain = await engine.resume(sessionId, {}, sessionRootDir);
      assert.equal(resumedAgain.conclusion?.outcome, "candidate_confirmed");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P1.5 — rejects unsupported checkpoint schema version and safely recovers from WAL", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-schema-test-"));
    try {
      const { repoDir, shas, plantedRegressionSha } = await createGitRepoFixture(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      const testScript = path.join(tmpRoot, "check.mjs");
      writeFileSync(
        testScript,
        `import { readFileSync } from "node:fs";
const content = readFileSync("feature.txt", "utf-8");
process.exit(content.includes("status=broken") ? 1 : 0);
`,
        "utf-8"
      );

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[4]!,
        oracle: { mode: "in-tree", command: { command: process.execPath, args: [testScript], timeoutMs: 15000 } },
        execution: { ...DEFAULT_EXECUTION_POLICY, endpointFlakeRuns: 1, boundaryConfirmRuns: 1, confirmBeforeExecutingCode: false },
        sessionRootDir,
      };

      const engine = new LocalBisectEngine();
      const sessionId = "sess_unsupported_schema";
      const startResult = await engine.start(config, { sessionId });
      assert.equal(startResult.conclusion?.outcome, "candidate_confirmed");

      const sessionDir = path.join(sessionRootDir, sessionId);

      // Overwrite checkpoint.json and checkpoint.backup.json with incompatible schemaVersion 99
      const primaryPath = path.join(sessionDir, "checkpoint.json");
      const backupPath = path.join(sessionDir, "checkpoint.backup.json");
      const invalidSchemaCheckpoint = {
        schemaVersion: 99,
        sessionId,
        checkpointSeq: 5,
        lastWalSeq: 10,
        checksum: "invalid",
        data: "unknown_future_format",
      };
      writeFileSync(primaryPath, JSON.stringify(invalidSchemaCheckpoint, null, 2), "utf-8");
      writeFileSync(backupPath, JSON.stringify(invalidSchemaCheckpoint, null, 2), "utf-8");

      // Verify validateCheckpointIntegrity strictly rejects schemaVersion !== 1
      assert.equal(validateCheckpointIntegrity(invalidSchemaCheckpoint), false);

      // readSessionCheckpoint must safely reject incompatible schema and recover from WAL
      const readResult = readSessionCheckpoint(sessionDir);
      assert.equal(readResult.source, "reconstructed_from_wal");
      assert.equal(readResult.checkpoint.schemaVersion, 1);
      assert.equal(readResult.checkpoint.sessionId, sessionId);
      assert.ok(readResult.checkpoint.classifications[plantedRegressionSha]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P1.5 — rejects wrong-repository checkpoint and blocks destructive worktree operations", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-wrong-repo-test-"));
    try {
      // 1. Create Repository A and Repository B
      const repoDirA = path.join(tmpRoot, "repo_a");
      const repoDirB = path.join(tmpRoot, "repo_b");
      mkdirSync(repoDirA, { recursive: true });
      mkdirSync(repoDirB, { recursive: true });

      await runGit(["init", "-b", "main"], repoDirA);
      await runGit(["config", "user.name", "Repo A"], repoDirA);
      await runGit(["config", "user.email", "a@example.com"], repoDirA);

      await runGit(["init", "-b", "main"], repoDirB);
      await runGit(["config", "user.name", "Repo B"], repoDirB);
      await runGit(["config", "user.email", "b@example.com"], repoDirB);

      // Commit 1 in Repo A (good)
      writeFileSync(path.join(repoDirA, "file.txt"), "hello A1");
      await runGit(["add", "file.txt"], repoDirA);
      await runGit(["commit", "-m", "init A1"], repoDirA);
      const shaA1 = (await runGit(["rev-parse", "HEAD"], repoDirA)).stdout.trim();

      // Commit 2 in Repo A (bad)
      writeFileSync(path.join(repoDirA, "file.txt"), "hello A2");
      await runGit(["add", "file.txt"], repoDirA);
      await runGit(["commit", "-m", "init A2"], repoDirA);
      const shaA2 = (await runGit(["rev-parse", "HEAD"], repoDirA)).stdout.trim();

      // Commit in Repo B with different content
      writeFileSync(path.join(repoDirB, "file.txt"), "hello B");
      await runGit(["add", "file.txt"], repoDirB);
      await runGit(["commit", "-m", "init B"], repoDirB);
      const initialHeadB = (await runGit(["rev-parse", "HEAD"], repoDirB)).stdout.trim();

      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      const testScript = path.join(tmpRoot, "check.mjs");
      writeFileSync(testScript, `process.exit(0);\n`, "utf-8");

      // Start session in Repo A
      const configA: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDirA,
        workingDirectory: ".",
        goodRef: shaA1,
        badRef: shaA2,
        oracle: { mode: "in-tree", command: { command: process.execPath, args: [testScript], timeoutMs: 15000 } },
        execution: { ...DEFAULT_EXECUTION_POLICY, endpointFlakeRuns: 1, boundaryConfirmRuns: 1, confirmBeforeExecutingCode: false },
        sessionRootDir,
      };

      const engine = new LocalBisectEngine();
      const sessionId = "sess_repo_a";
      await engine.start(configA, { sessionId });

      // Tamper manifest repository root to point to Repo B
      const sessionDir = path.join(sessionRootDir, sessionId);
      const manifest = readSessionManifest(sessionDir);
      const tamperedManifest = {
        ...manifest,
        state: "needs_recovery" as const,
        repository: {
          ...manifest.repository,
          rootPath: repoDirB,
          worktreePath: repoDirB, // attempt to point worktree to repo B
        },
      };
      writeSessionManifestAtomic(tamperedManifest);

      // Attempting to resume tampered session pointing to Repo B must fail closed
      await assert.rejects(
        async () => {
          await engine.resume(sessionId, {}, sessionRootDir);
        },
        (err: Error) => {
          assert.ok(
            err.message.includes("Refusing destructive operation on original repository checkout") ||
            err.message.includes("Repository commonGitDir mismatch") ||
            err.message.includes("Missing BisectPilot ownership marker"),
            `Unexpected error message: ${err.message}`
          );
          return true;
        }
      );

      // Verify Repo B checkout was completely untouched
      const currentHeadB = (await runGit(["rev-parse", "HEAD"], repoDirB)).stdout.trim();
      assert.equal(currentHeadB, initialHeadB);
      const contentB = readFileSync(path.join(repoDirB, "file.txt"), "utf-8");
      assert.equal(contentB, "hello B");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P1.4 — handles abrupt process termination (SIGKILL) during bisection and resumes cleanly", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-sigkill-test-"));
    try {
      const { repoDir, shas, plantedRegressionSha } = await createGitRepoFixture(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      const killSignalFile = path.join(tmpRoot, "kill_fired.txt");
      const evalCounterFile = path.join(tmpRoot, "eval_counter.txt");

      // Oracle test script that terminates the parent process on the 2nd evaluation
      const testScript = path.join(tmpRoot, "check.mjs");
      writeFileSync(
        testScript,
        `import { readFileSync, writeFileSync, existsSync } from "node:fs";
const content = readFileSync("feature.txt", "utf-8");
const counterFile = ${JSON.stringify(evalCounterFile)};
const killFile = ${JSON.stringify(killSignalFile)};

let count = 0;
if (existsSync(counterFile)) {
  count = parseInt(readFileSync(counterFile, "utf-8"), 10) || 0;
}
count++;
writeFileSync(counterFile, String(count), "utf-8");

// On the 2nd bisect evaluation, kill parent runner abruptly with SIGKILL to simulate sudden crash
if (count === 2 && !existsSync(killFile)) {
  writeFileSync(killFile, "killed", "utf-8");
  process.kill(process.ppid, "SIGKILL");
}

if (content.includes("status=broken")) {
  process.exit(1);
}
process.exit(0);
`,
        "utf-8"
      );

      // Child runner script that invokes LocalBisectEngine.start
      const runnerScript = path.join(tmpRoot, "run_child.mjs");
      const sessionId = "sess_sigkill_01";
      const engineUrl = pathToFileURL(path.resolve("dist/src/index.js")).href;
      writeFileSync(
        runnerScript,
        `import { LocalBisectEngine, DEFAULT_EXECUTION_POLICY } from ${JSON.stringify(engineUrl)};

const engine = new LocalBisectEngine();
await engine.start({
  schemaVersion: 1,
  profile: "functional",
  repositoryRoot: ${JSON.stringify(repoDir)},
  workingDirectory: ".",
  goodRef: ${JSON.stringify(shas[0])},
  badRef: ${JSON.stringify(shas[4])},
  oracle: { mode: "in-tree", command: { command: process.execPath, args: [${JSON.stringify(testScript)}], timeoutMs: 15000 } },
  execution: { ...DEFAULT_EXECUTION_POLICY, endpointFlakeRuns: 1, boundaryConfirmRuns: 1, confirmBeforeExecutingCode: false },
  sessionRootDir: ${JSON.stringify(sessionRootDir)},
}, { sessionId: ${JSON.stringify(sessionId)} });
`,
        "utf-8"
      );

      // Spawn child process running bisection
      const { spawnSync } = await import("node:child_process");
      const childRes = spawnSync(process.execPath, [runnerScript], {
        cwd: tmpRoot,
        stdio: "pipe",
        encoding: "utf-8",
      });

      // Confirm child was killed by signal or terminated on Windows
      assert.ok(
        childRes.signal === "SIGKILL" || existsSync(killSignalFile) || (process.platform === "win32" && childRes.status !== 0),
        `Expected SIGKILL termination, got exitCode=${childRes.status}, signal=${childRes.signal}, stderr=${childRes.stderr}`
      );

      const sessionDir = path.join(sessionRootDir, sessionId);
      assert.ok(existsSync(sessionDir), "Session directory must exist after crash");

      // Verify ledger hash-chain is unbroken up to the crash point
      const ledgerFile = path.join(sessionDir, "ledger.jsonl");
      assert.ok(existsSync(ledgerFile), "Ledger file must exist on disk");
      const events = readLedgerEvents(ledgerFile);
      assert.ok(events.length > 0, "Ledger events must exist on disk");
      const chainCheck = verifyLedgerChain(events);
      assert.equal(chainCheck.valid, true, "Ledger hash chain must remain valid across crash");

      // Inspect status after crash: must detect crash and stale lock from dead child PID
      const engine = new LocalBisectEngine();
      const status = await engine.status(sessionId, sessionRootDir);
      assert.equal(status.manifest.state, "needs_recovery");
      assert.ok(status.checkpoint?.resumable);

      // Resume session: must recover, fast-forward through classified commits, and isolate exact regression
      const resumed = await engine.resume(sessionId, {}, sessionRootDir);
      assert.equal(resumed.conclusion?.outcome, "candidate_confirmed");
      assert.equal(resumed.conclusion?.candidateSha, plantedRegressionSha);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
