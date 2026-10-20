import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  LocalBisectEngine,
  readLedgerEvents,
  resolveRefToSha,
  runGit,
  verifyLedgerChain,
  type BisectConfigV1,
} from "../../src/index.js";

async function createLinearRegressionRepo(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
  readonly plantedBadSha: string;
}> {
  const repoDir = path.join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Test Bot"], repoDir);
  await runGit(["config", "user.email", "bot@example.com"], repoDir);

  const shas: string[] = [];
  // Create 6 commits: C1..C3 return 42 (good), C4..C6 return 99 (planted regression at C4)
  for (let i = 1; i <= 6; i++) {
    const value = i >= 4 ? 99 : 42;
    writeFileSync(
      path.join(repoDir, "calc.mjs"),
      `export const answer = ${value};\nexport const step = ${i};\n`,
      "utf-8"
    );
    writeFileSync(
      path.join(repoDir, "in-tree-check.mjs"),
      `import { answer } from "./calc.mjs";\nprocess.exit(answer === 42 ? 0 : 1);\n`,
      "utf-8"
    );
    await runGit(["add", "calc.mjs", "in-tree-check.mjs"], repoDir);
    await runGit(["commit", "-m", `commit C${i}`], repoDir);
    shas.push(await resolveRefToSha(repoDir, "HEAD"));
  }

  return {
    repoDir,
    shas,
    plantedBadSha: shas[3]!, // C4 (0-indexed 3)
  };
}

describe("A4–A10 — End-to-End BisectEngine Integration (In-Tree, Overlay, Preflight & Recovery)", () => {
  it("finds the exact planted regression SHA via native git bisect in overlay mode while keeping dirty original checkout untouched", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-e2e-"));
    try {
      const { repoDir, shas, plantedBadSha } = await createLinearRegressionRepo(tmpRoot);
      const sessionsRoot = path.join(tmpRoot, "sessions");

      // Write an untracked regression test in the user's working tree (does not exist in C1..C6 history!)
      writeFileSync(
        path.join(repoDir, "overlay-reg-test.mjs"),
        `import { answer } from "./calc.mjs";\nif (answer !== 42) process.exit(1);\n`,
        "utf-8"
      );
      // Also dirty a tracked file in the user's original checkout
      writeFileSync(path.join(repoDir, "calc.mjs"), "// local uncommitted edit\nexport const answer = 0;\n", "utf-8");

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[5]!,
        oracle: {
          mode: "overlay",
          command: {
            command: "node",
            args: ["overlay-reg-test.mjs"],
            timeoutMs: 10_000,
          },
          overlayFiles: ["overlay-reg-test.mjs"],
          overlayConflictPolicy: "skip",
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 2,
          boundaryConfirmRuns: 2,
          confirmBeforeExecutingCode: true,
        },
        sessionRootDir: sessionsRoot,
      };

      const engine = new LocalBisectEngine();
      const manifest = await engine.start(config, {
        sessionId: "sess-overlay-01",
        confirm: () => true,
      });

      assert.equal(manifest.state, "concluded");
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, plantedBadSha);
      assert.equal(manifest.conclusion?.parentSha, shas[2]!);

      // Verify overlay file was removed from the session worktree after evaluation
      assert.equal(
        existsSync(path.join(manifest.repository.worktreePath, "overlay-reg-test.mjs")),
        false
      );

      // Verify ledger hash chain integrity & generated report artifacts
      const events = readLedgerEvents(manifest.ledgerPath);
      assert.equal(verifyLedgerChain(events).valid, true);
      assert.equal(existsSync(path.join(manifest.sessionDir, "report.md")), true);
      assert.equal(existsSync(path.join(manifest.sessionDir, "report.json")), true);
      assert.equal(existsSync(path.join(manifest.sessionDir, "repro.sh")), true);
      assert.equal(existsSync(path.join(manifest.sessionDir, "bisect.log")), true);

      // Verify user's original checkout still has its uncommitted edit and overlay file intact
      assert.equal(
        readFileSync(path.join(repoDir, "calc.mjs"), "utf-8"),
        "// local uncommitted edit\nexport const answer = 0;\n"
      );
      assert.equal(existsSync(path.join(repoDir, "overlay-reg-test.mjs")), true);

      // Clean up the session worktree safely
      const cleanupRes = await engine.cleanup("sess-overlay-01", { dryRun: false }, sessionsRoot);
      assert.equal(cleanupRes.removedWorktree, true);
      assert.equal(cleanupRes.state, "cleaned_up");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("stops at preflight when endpoints contradict (good fails or bad passes)", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-contradict-"));
    try {
      const { repoDir, shas } = await createLinearRegressionRepo(tmpRoot);
      const sessionsRoot = path.join(tmpRoot, "sessions");

      // Both C1 and C2 are good (answer === 42), so badRef=C2 will pass and contradict!
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[1]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["in-tree-check.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 2,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: sessionsRoot,
      };

      const engine = new LocalBisectEngine();
      const manifest = await engine.start(config, {
        sessionId: "sess-contradict",
        autoCleanup: true,
      });

      assert.equal(manifest.state, "cleaned_up");
      assert.equal(manifest.conclusion?.outcome, "inconclusive");
      assert.equal(manifest.conclusion?.inconclusiveReason, "endpoints_contradict");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("supports external oracle mode and recovers/resumes a crashed session with a stale lock", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-ext-resume-"));
    try {
      const { repoDir, shas, plantedBadSha } = await createLinearRegressionRepo(tmpRoot);
      const sessionsRoot = path.join(tmpRoot, "sessions");
      const extScript = path.join(repoDir, "ext-oracle.mjs");
      writeFileSync(
        extScript,
        `import { pathToFileURL } from "node:url";
         import path from "node:path";
         const mod = await import(pathToFileURL(path.resolve("calc.mjs")).href);
         process.exit(mod.answer === 42 ? 0 : 1);\n`,
        "utf-8"
      );

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[5]!,
        oracle: {
          mode: "external",
          command: {
            command: "node",
            args: ["ext-oracle.mjs"],
            timeoutMs: 10_000,
          },
          externalScriptPath: "ext-oracle.mjs",
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: true,
        },
        sessionRootDir: sessionsRoot,
      };

      const engine = new LocalBisectEngine();
      // Start and decline consent to get an initialized session directory, then simulate a mid-run crash
      const initial = await engine.start(config, {
        sessionId: "sess-crash-01",
        confirm: () => false,
      });
      assert.equal(initial.state, "cancelled");

      // Simulate a crashed process in bisect_running with a dead PID lockfile
      const crashedManifest = {
        ...initial,
        state: "bisect_running" as const,
      };
      writeFileSync(
        path.join(initial.sessionDir, "manifest.json"),
        JSON.stringify(crashedManifest, null, 2) + "\n",
        "utf-8"
      );
      writeFileSync(
        path.join(initial.sessionDir, "session.lock"),
        JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAt: new Date().toISOString() }),
        "utf-8"
      );

      const statusReport = await engine.status("sess-crash-01", sessionsRoot);
      assert.equal(statusReport.manifest.state, "needs_recovery");
      assert.equal(statusReport.lockStatus, "locked_stale");

      // Resume from needs_recovery and verify it finds the exact planted SHA
      const resumed = await engine.resume("sess-crash-01", { autoCleanup: true }, sessionsRoot);
      assert.equal(resumed.state, "cleaned_up");
      assert.equal(resumed.conclusion?.outcome, "candidate_confirmed");
      assert.equal(resumed.conclusion?.candidateSha, plantedBadSha);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
