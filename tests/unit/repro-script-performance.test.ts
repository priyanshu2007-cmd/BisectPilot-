import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EXECUTION_POLICY, type SessionManifestV1 } from "../../src/contracts/index.js";
import { generateReproScript } from "../../src/reports/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

test("Bug 7 - repro.sh handles performance profile and exit code 125 skip", async (t) => {
  const fixture = await buildFixtureRepo([
    { message: "commit 0 (parent)", files: { "test.sh": "#!/bin/sh\nexit 125\n" } },
    { message: "commit 1 (candidate)", files: { "test.sh": "#!/bin/sh\nexit 1\n" } },
  ]);

  try {
    const parentSha = fixture.commitShas[0]!;
    const candidateSha = fixture.commitShas[1]!;

    // 1. Performance profile session
    const perfManifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "bp-perf-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "concluded",
      sessionDir: "/tmp/fake-session",
      ledgerPath: "/tmp/fake-session/ledger.jsonl",
      repository: {
        rootPath: fixture.repoDir,
        commonGitDir: path.join(fixture.repoDir, ".git"),
        originalHead: candidateSha,
        originalWasDirty: false,
        worktreePath: "/tmp/fake-session/worktree",
        createdByTool: true,
      },
      bounds: {
        goodInputRef: parentSha,
        goodSha: parentSha,
        badInputRef: candidateSha,
        badSha: candidateSha,
      },
      configHash: "fakehash",
      config: {
        schemaVersion: 1,
        profile: "performance",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: parentSha,
        badRef: candidateSha,
        oracle: {
          mode: "in-tree",
          command: { command: "node", args: ["bench.js"], timeoutMs: 5000 },
        },
        execution: DEFAULT_EXECUTION_POLICY,
      },
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [parentSha, candidateSha],
      lastRecordedRevision: candidateSha,
      runnerVersion: "0.1.0",
      conclusion: {
        outcome: "candidate_confirmed",
        candidateSha,
        parentSha,
        skippedShas: [],
        explanation: "Performance regression found",
      },
    };

    const perfScript = generateReproScript(perfManifest);
    assert.ok(
      perfScript.includes("compare these numbers; the verdict needs statistics, see report"),
      "Performance script must include statistics comparison note"
    );
    assert.ok(
      !perfScript.includes('if [ "$PARENT_RES" = "good" ]'),
      "Performance script must not use exit code equality for good/bad outcome"
    );

    // 2. Noisy session header check
    const noisyManifest: SessionManifestV1 = {
      ...perfManifest,
      config: {
        ...perfManifest.config,
        profile: "functional",
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          noisyOracle: {
            enabled: true,
            maxSamplesPerRevision: 5,
            confidenceThreshold: 0.9,
            flakeRate: 0.1,
          },
        },
      },
    };
    const noisyScript = generateReproScript(noisyManifest);
    assert.ok(
      noisyScript.includes("--noisy") || noisyScript.includes("noisy"),
      "Noisy session script must mention noisy sampling in header"
    );

    // 3. Functional session with exit code 125 (skip) on parent
    const funcManifest: SessionManifestV1 = {
      ...perfManifest,
      config: {
        ...perfManifest.config,
        profile: "functional",
        oracle: {
          mode: "in-tree",
          command: { command: "sh", args: ["test.sh"], timeoutMs: 5000 },
        },
      },
    };

    const funcScript = generateReproScript(funcManifest);
    const scriptPath = path.join(fixture.tmpRoot, "test-repro.sh");
    writeFileSync(scriptPath, funcScript, { mode: 0o755 });

    let runOutput = "";
    let exitCode = 0;
    try {
      runOutput = execFileSync("bash", [scriptPath], { encoding: "utf-8" });
    } catch (err: any) {
      exitCode = err.status;
      runOutput = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    }

    assert.ok(
      runOutput.includes("parent: skip"),
      `Expected output to report parent: skip, got:\n${runOutput}`
    );
    assert.notEqual(exitCode, 0, "Script should exit non-zero when a revision is skipped");
  } finally {
    fixture.cleanup();
  }
});
