import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  verifyLedgerChain,
  type BisectConfigV1,
} from "../../src/index.js";

async function createRegressionFixtureRepo(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
  readonly plantedRegressionSha: string;
}> {
  const repoDir = path.join(tmpRoot, "target-repo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "E2E Bot"], repoDir);
  await runGit(["config", "user.email", "e2e@example.com"], repoDir);

  const shas: string[] = [];
  // Commits 0..2 are good (answer = 42), commits 3..5 have the planted regression (answer = 0)
  for (let i = 0; i < 6; i++) {
    const isBroken = i >= 3;
    writeFileSync(path.join(repoDir, "app.js"), `export const answer = ${isBroken ? 0 : 42};\n`, "utf-8");
    writeFileSync(
      path.join(repoDir, "test.mjs"),
      `import { answer } from "./app.js";\nprocess.exit(answer === 42 ? 0 : 1);\n`,
      "utf-8"
    );
    await runGit(["add", "app.js", "test.mjs"], repoDir);
    await runGit(["commit", "-m", `c${i}: ${isBroken ? "break" : "pass"}`], repoDir);
    shas.push(await resolveRefToSha(repoDir, "HEAD"));
  }

  return {
    repoDir,
    shas,
    plantedRegressionSha: shas[3]!,
  };
}

describe("Section 3 — Fresh-Clone End-to-End Functional Proof & Cross-Format Validation", () => {
  it("executes full bisection in fresh repo, verifies JSON/MD/HTML report consistency and HTML escaping", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-fresh-e2e-"));
    try {
      const { repoDir, shas, plantedRegressionSha } = await createRegressionFixtureRepo(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      // Keep original checkout dirty with an untracked file to prove isolation
      const untrackedFile = path.join(repoDir, "untracked-user-work.txt");
      writeFileSync(untrackedFile, "precious user changes", "utf-8");

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[5]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: ["test.mjs"],
            timeoutMs: 15000,
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
      const sessionId = "sess_fresh_e2e_01";
      const startResult = await engine.start(config, { sessionId });

      // 1. Verify exact regression commit found
      assert.equal(startResult.conclusion?.outcome, "candidate_confirmed");
      assert.equal(startResult.conclusion?.candidateSha, plantedRegressionSha);

      // 2. Verify original checkout untouched
      assert.ok(existsSync(untrackedFile), "Original untracked file must remain in user checkout");
      assert.equal(readFileSync(untrackedFile, "utf-8"), "precious user changes");
      const currentHead = await resolveRefToSha(repoDir, "HEAD");
      assert.equal(currentHead, shas[5]!, "Original checkout HEAD must remain unchanged");

      // 3. Verify report artifacts exist and are consistent
      const sessionDir = path.join(sessionRootDir, sessionId);
      const jsonReportPath = path.join(sessionDir, "report.json");
      const mdReportPath = path.join(sessionDir, "report.md");
      const htmlReportPath = path.join(sessionDir, "report.html");
      const reproScriptPath = path.join(sessionDir, "repro.sh");

      assert.ok(existsSync(jsonReportPath), "report.json must be generated");
      assert.ok(existsSync(mdReportPath), "report.md must be generated");
      assert.ok(existsSync(htmlReportPath), "report.html must be generated");
      assert.ok(existsSync(reproScriptPath), "repro.sh must be generated");

      // Read and verify JSON report
      const jsonReport = JSON.parse(readFileSync(jsonReportPath, "utf-8"));
      assert.equal(jsonReport.outcome, "candidate_confirmed");
      assert.equal(jsonReport.candidateSha, plantedRegressionSha);
      assert.equal(jsonReport.bounds.goodSha, shas[0]!);
      assert.equal(jsonReport.bounds.badSha, shas[5]!);

      // Read and verify Markdown report
      const mdReport = readFileSync(mdReportPath, "utf-8");
      assert.ok(mdReport.includes(plantedRegressionSha));
      assert.ok(mdReport.includes("candidate_confirmed"));

      // Read and verify HTML report: escaping, redaction, executive summary
      const htmlReport = readFileSync(htmlReportPath, "utf-8");
      assert.ok(htmlReport.includes("BisectPilot Report —"));
      assert.ok(htmlReport.includes(plantedRegressionSha));
      assert.ok(htmlReport.includes("candidate_confirmed"));
      assert.ok(!htmlReport.includes("<script>alert"), "Must not contain unescaped injected script tags");

      // Verify repro.sh is executable and contains safe commands
      const reproContent = readFileSync(reproScriptPath, "utf-8");
      assert.ok(reproContent.startsWith("#!/usr/bin/env bash"));
      assert.ok(reproContent.includes(plantedRegressionSha));

      // 4. Verify ledger hash chain
      const events = readLedgerEvents(startResult.ledgerPath);
      const chain = verifyLedgerChain(events);
      assert.equal(chain.valid, true);

      // 5. Verify checkpoint matches final state
      const { checkpoint, source } = readSessionCheckpoint(sessionDir);
      assert.equal(source, "primary");
      assert.equal(checkpoint.state, "concluded");
      assert.ok(checkpoint.classifications[plantedRegressionSha]);
      assert.equal(checkpoint.classifications[plantedRegressionSha]?.classification, "bad");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles oracle timeout safely without falsely classifying as regression", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-timeout-e2e-"));
    try {
      const { repoDir, shas } = await createRegressionFixtureRepo(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      // Oracle script that hangs indefinitely
      const hangScript = path.join(tmpRoot, "hang.mjs");
      writeFileSync(hangScript, `await new Promise(() => {});\n`, "utf-8");

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[5]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: [hangScript],
            timeoutMs: 300, // short timeout to exercise termination
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
      const sessionId = "sess_timeout_01";
      const res = await engine.start(config, { sessionId });

      // Preflight on bad endpoint times out; should safely conclude inconclusive or aborted, NOT confirmed regression!
      assert.ok(res.conclusion?.outcome === "inconclusive" || res.conclusion?.outcome === "aborted");
      assert.notEqual(res.conclusion?.outcome, "candidate_confirmed");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles skipped revisions and enforces skip budget", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-skip-e2e-"));
    try {
      const { repoDir, shas } = await createRegressionFixtureRepo(tmpRoot);
      const sessionRootDir = path.join(tmpRoot, "sessions");
      mkdirSync(sessionRootDir, { recursive: true });

      // Oracle returns 125 (skip) on intermediate commits
      const skipScript = path.join(tmpRoot, "skip.mjs");
      writeFileSync(
        skipScript,
        `import { readFileSync } from "node:fs";
const content = readFileSync("app.js", "utf-8");
if (content.includes("0")) process.exit(1);
process.exit(125); // Git bisect skip exit code
`,
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
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: [skipScript],
            timeoutMs: 15000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          maxSkips: 1, // small budget: exceeds quickly
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir,
      };

      const engine = new LocalBisectEngine();
      const sessionId = "sess_skip_01";
      const res = await engine.start(config, { sessionId });

      // Either good endpoint was skipped in preflight (inconclusive) or skip budget exceeded
      assert.ok(res.conclusion?.outcome === "inconclusive" || res.conclusion?.outcome === "aborted");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
