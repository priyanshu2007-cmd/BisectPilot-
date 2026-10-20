import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXECUTION_POLICY,
  type BisectConfigV1,
} from "../../src/contracts/config.js";
import { generateReproScript, writeSessionReportArtifacts } from "../../src/reports/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";

test("Feature C — Standalone Reproducibility Script Generator", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-repro-gen-test-"));

  const manifest = {
    schemaVersion: 1 as const,
    id: "bp-test-repro-123",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "concluded" as const,
    sessionDir: tmpDir,
    ledgerPath: path.join(tmpDir, "ledger.jsonl"),
    repository: {
      rootPath: tmpDir,
      commonGitDir: path.join(tmpDir, ".git"),
      worktreePath: path.join(tmpDir, "worktree"),
      originalHead: "1111111111111111111111111111111111111111",
      originalWasDirty: false,
      initialCommitSha: "1111111111111111111111111111111111111111",
      createdByTool: true as const,
    },
    bounds: {
      goodInputRef: "v1.0",
      goodSha: "1111111111111111111111111111111111111111",
      badInputRef: "v2.0",
      badSha: "2222222222222222222222222222222222222222",
    },
    configHash: "dummyhash",
    config: {
      schemaVersion: 1 as const,
      profile: "functional" as const,
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: "v1.0",
      badRef: "v2.0",
      oracle: {
        mode: "in-tree" as const,
        command: { command: "npm", args: ["test", "--", "--grep='test; rm -rf /'"], timeoutMs: 30_000 },
      },
      execution: DEFAULT_EXECUTION_POLICY,
    },
    overlayHashes: {},
    skipCount: 0,
    testedRevisions: [],
    runnerVersion: "0.1.0",
    conclusion: {
      outcome: "candidate_confirmed" as const,
      candidateSha: "2222222222222222222222222222222222222222",
      parentSha: "1111111111111111111111111111111111111111",
      skippedShas: [],
      explanation: "Regression confirmed.",
    },
  };

  await t.test("generates standalone script with header context and safe argument escaping", () => {
    const script = generateReproScript(manifest);
    assert.match(script, /^#!\/usr\/bin\/env bash/);
    assert.match(script, /# BisectPilot Standalone Reproducibility Script — Session bp-test-repro-123/);
    assert.match(script, /Reference Ledger:/);
    assert.match(script, /Reference Report:/);
    assert.match(script, /PARENT_SHA='1111111111111111111111111111111111111111'/);
    assert.match(script, /CANDIDATE_SHA='2222222222222222222222222222222222222222'/);
    assert.match(script, /CI="1"/);
    assert.match(script, /TZ="UTC"/);
    assert.match(script, /NO_COLOR="1"/);
    assert.ok(script.includes("'npm' 'test' '--'"));
    assert.ok(script.includes("test; rm -rf /"));
  });

  await t.test("writeSessionReportArtifacts writes executable repro.sh (0o755)", () => {
    const artifacts = writeSessionReportArtifacts({
      manifest,
      events: [],
    });
    assert.ok(existsSync(artifacts.reproScriptPath));
    const mode = statSync(artifacts.reproScriptPath).mode;
    // Check executable permission for user (0o100)
    assert.ok((mode & 0o100) !== 0, "repro.sh should be marked executable");
  });

  rmSync(tmpDir, { recursive: true, force: true });
});

test("Feature C — repro.sh standalone execution in real Git fixture", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-repro-run-test-"));
  try {
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });

    // Commit 1: good
    writeFileSync(path.join(tmpDir, "check.js"), "process.exit(0);\n", "utf-8");
    execSync("git add check.js && git commit -m 'c1: good'", { cwd: tmpDir, stdio: "ignore" });
    const c1Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    // Commit 2: bad
    writeFileSync(path.join(tmpDir, "check.js"), "process.exit(1);\n", "utf-8");
    execSync("git add check.js && git commit -m 'c2: bad'", { cwd: tmpDir, stdio: "ignore" });
    const c2Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    const config: BisectConfigV1 = {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: c1Sha,
      badRef: c2Sha,
      oracle: {
        mode: "in-tree",
        command: {
          command: "node",
          args: ["check.js"],
          timeoutMs: 30_000,
        },
      },
      execution: {
        ...DEFAULT_EXECUTION_POLICY,
        endpointFlakeRuns: 1,
        boundaryConfirmRuns: 1,
        confirmBeforeExecutingCode: false,
      },
    };

    const engine = new LocalBisectEngine();
    const manifest = await engine.start(config);

    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");

    const reproPath = path.join(manifest.sessionDir, "repro.sh");
    assert.ok(existsSync(reproPath), "repro.sh should exist");

    // Execute repro.sh directly on POSIX
    if (process.platform !== "win32") {
      const reproOutput = execSync(`bash ${reproPath}`, { encoding: "utf-8" });
      assert.match(reproOutput, /parent: good, candidate: bad/);
    }

    await engine.cleanup(manifest.id, { dryRun: false }, path.dirname(manifest.sessionDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
