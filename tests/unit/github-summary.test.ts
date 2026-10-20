import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXECUTION_POLICY,
  type BisectConfigV1,
} from "../../src/contracts/config.js";
import type { LedgerEvent, SessionManifestV1 } from "../../src/contracts/index.js";
import {
  appendGitHubStepSummary,
  generateGitHubIssueMarkdown,
  generateGitHubStepSummary,
} from "../../src/reports/index.js";
import { runCli } from "../../src/cli/index.js";
import { FakeEngine } from "../../src/contracts/fake-engine.js";

function createMockManifest(overrides?: Partial<SessionManifestV1>): SessionManifestV1 {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-gh-test-"));
  return {
    schemaVersion: 1,
    id: "bp-test-session-gh",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "concluded",
    sessionDir: tmpDir,
    ledgerPath: path.join(tmpDir, "ledger.jsonl"),
    repository: {
      rootPath: tmpDir,
      commonGitDir: path.join(tmpDir, ".git"),
      worktreePath: path.join(tmpDir, "worktree"),
      originalHead: "1111111111111111111111111111111111111111",
      originalWasDirty: false,
      createdByTool: true,
    },
    bounds: {
      goodInputRef: "v1.0",
      goodSha: "1111111111111111111111111111111111111111",
      badInputRef: "v2.0",
      badSha: "2222222222222222222222222222222222222222",
    },
    configHash: "dummyhash",
    config: {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: "v1.0",
      badRef: "v2.0",
      oracle: {
        mode: "in-tree",
        command: { command: "npm", args: ["test"], timeoutMs: 30_000 },
      },
      execution: DEFAULT_EXECUTION_POLICY,
    },
    overlayHashes: {},
    skipCount: 0,
    testedRevisions: [],
    runnerVersion: "0.1.0",
    conclusion: {
      outcome: "candidate_confirmed",
      candidateSha: "2222222222222222222222222222222222222222",
      parentSha: "1111111111111111111111111111111111111111",
      skippedShas: [],
      explanation: "Regression isolated to commit 22222222.",
    },
    ...overrides,
  };
}

test("Feature B — GitHub Actions Summary & Export", async (t) => {
  await t.test("generates GitHub Actions step summary markdown with required tables and context", () => {
    const manifest = createMockManifest();
    const events: LedgerEvent[] = [
      {
        schemaVersion: 1,
        seq: 1,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        eventHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        type: "session_created",
        goodSha: manifest.bounds.goodSha,
        badSha: manifest.bounds.badSha,
        worktreePath: manifest.repository.worktreePath,
        overlayHashes: {},
      },
      {
        schemaVersion: 1,
        seq: 2,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        eventHash: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        type: "revision_classified",
        commitSha: "2222222222222222222222222222222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "test pipe | safe check",
        gitExitCode: 1,
        overlayHashes: {},
      },
    ];

    const summary = generateGitHubStepSummary(manifest, events);

    assert.match(summary, /^# 🎯 BisectPilot Investigation Summary/);
    assert.ok(summary.includes("Session ID:** `bp-test-session-gh`"));
    assert.ok(summary.includes("Suspected First Bad Commit"));
    assert.ok(summary.includes("2222222222222222222222222222222222222222"));
    assert.ok(summary.includes("Verified Last Good Parent"));
    assert.ok(summary.includes("1111111111111111111111111111111111111111"));
    assert.ok(summary.includes("test pipe \\| safe check"), "Pipes in details must be escaped for markdown tables");
    assert.ok(summary.includes("Local Reproduction"));
    assert.ok(summary.includes(`bash .bisectpilot/sessions/${manifest.id}/repro.sh`));
    assert.ok(summary.includes("Notes & Limitations"));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("generates GitHub Issue and Pull-Request markdown export", () => {
    const manifest = createMockManifest();
    const events: LedgerEvent[] = [
      {
        schemaVersion: 1,
        seq: 1,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        eventHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        type: "session_created",
        goodSha: manifest.bounds.goodSha,
        badSha: manifest.bounds.badSha,
        worktreePath: manifest.repository.worktreePath,
        overlayHashes: {},
      },
      {
        schemaVersion: 1,
        seq: 2,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        eventHash: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        type: "revision_classified",
        commitSha: "2222222222222222222222222222222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "test failed",
        gitExitCode: 1,
        overlayHashes: {},
      },
    ];

    const issueMd = generateGitHubIssueMarkdown(manifest, events);

    assert.match(issueMd, /^## 🐛 Regression Report — Suspected First Bad Commit: `2222222222222222222222222222222222222222`/);
    assert.ok(issueMd.includes("Oracle Command:** `npm test`"));
    assert.ok(issueMd.includes("<details>"));
    assert.ok(issueMd.includes("Click to view 1 evaluated revisions"));
    assert.ok(issueMd.includes("Local Reproduction"));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("appendGitHubStepSummary safely appends to file without deleting existing contents", () => {
    const tmpSummary = path.join(os.tmpdir(), `test-step-summary-${Date.now()}.md`);
    writeFileSync(tmpSummary, "### Existing CI Step\nInitial log output.\n\n", "utf-8");

    try {
      const summaryText = "## BisectPilot Results\nRegression identified.";
      const res = appendGitHubStepSummary(summaryText, tmpSummary);

      assert.strictEqual(res.written, true);
      assert.strictEqual(res.targetPath, tmpSummary);

      const content = readFileSync(tmpSummary, "utf-8");
      assert.ok(content.startsWith("### Existing CI Step\nInitial log output."));
      assert.ok(content.includes("## BisectPilot Results\nRegression identified."));
    } finally {
      if (existsSync(tmpSummary)) {
        rmSync(tmpSummary, { force: true });
      }
    }
  });

  await t.test("appendGitHubStepSummary handles missing GITHUB_STEP_SUMMARY gracefully", () => {
    const oldVal = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      const res = appendGitHubStepSummary("test summary");
      assert.strictEqual(res.written, false);
      assert.strictEqual(res.targetPath, undefined);
    } finally {
      if (oldVal !== undefined) {
        process.env.GITHUB_STEP_SUMMARY = oldVal;
      }
    }
  });

  await t.test("appendGitHubStepSummary returns failure info on invalid path without crashing", () => {
    // Attempting to append to an impossible directory path
    const invalidPath = "/nonexistent-dir-for-sure-12345/summary.md";
    const res = appendGitHubStepSummary("test summary", invalidPath);
    assert.strictEqual(res.written, false);
    assert.strictEqual(res.targetPath, invalidPath);
    assert.ok(typeof res.error === "string");
  });

  await t.test("CLI integration: report supports --html, --github-summary, --github-issue, and --out", async () => {
    const manifest = createMockManifest();
    writeFileSync(manifest.ledgerPath, "", "utf-8");

    const fakeEngine = new FakeEngine();
    fakeEngine.addSession(manifest);

    const tmpOutHtml = path.join(manifest.sessionDir, "custom-out.html");
    const tmpOutIssue = path.join(manifest.sessionDir, "custom-issue.md");
    const tmpSummaryFile = path.join(manifest.sessionDir, "step-summary.md");

    // Test --html --out
    const codeHtml = await runCli(
      ["report", manifest.id, "--html", "--out", tmpOutHtml, "--session-root", path.dirname(manifest.sessionDir)],
      fakeEngine
    );
    assert.strictEqual(codeHtml, 0);
    assert.ok(existsSync(tmpOutHtml));
    assert.match(readFileSync(tmpOutHtml, "utf-8"), /^<!DOCTYPE html>/);

    // Test --github-issue --out
    const codeIssue = await runCli(
      ["report", manifest.id, "--github-issue", "--out", tmpOutIssue, "--session-root", path.dirname(manifest.sessionDir)],
      fakeEngine
    );
    assert.strictEqual(codeIssue, 0);
    assert.ok(existsSync(tmpOutIssue));
    assert.match(readFileSync(tmpOutIssue, "utf-8"), /^## 🐛 Regression Report/);

    // Test --github-summary <path>
    const codeSummary = await runCli(
      ["report", manifest.id, "--github-summary", tmpSummaryFile, "--session-root", path.dirname(manifest.sessionDir)],
      fakeEngine
    );
    assert.strictEqual(codeSummary, 0);
    assert.ok(existsSync(tmpSummaryFile));
    assert.match(readFileSync(tmpSummaryFile, "utf-8"), /^# 🎯 BisectPilot Investigation Summary/);

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });
});
