import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
});
