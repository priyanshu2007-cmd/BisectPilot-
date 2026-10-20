import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LedgerEvent, SessionManifestV1 } from "../../src/contracts/index.js";
import {
  collapseConsecutiveEvaluations,
  generateJsonReport,
  generateMarkdownReport,
} from "../../src/reports/index.js";
import { generateHtmlReport } from "../../src/reports/html-report.js";

function createTestManifest(): SessionManifestV1 {
  return {
    schemaVersion: 1,
    id: "collapse-test-session",
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:05.000Z",
    state: "concluded",
    sessionDir: "/tmp/collapse-test-session",
    ledgerPath: "/tmp/collapse-test-session/ledger.jsonl",
    repository: {
      rootPath: "/repo",
      commonGitDir: "/repo/.git",
      originalHead: "9999999999999999999999999999999999999999",
      originalWasDirty: false,
      worktreePath: "/tmp/collapse-test-session/worktree",
      createdByTool: true,
    },
    bounds: {
      goodInputRef: "v1.0",
      goodSha: "1111111111111111111111111111111111111111",
      badInputRef: "v2.0",
      badSha: "9999999999999999999999999999999999999999",
    },
    configHash: "cfg-hash",
    config: {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/repo",
      workingDirectory: ".",
      goodRef: "v1.0",
      badRef: "v2.0",
      oracle: {
        mode: "in-tree",
        command: { command: "npm", args: ["test"], timeoutMs: 30000 },
        overlayConflictPolicy: "skip",
      },
      execution: {
        maxOutputBytesPerCommand: 100000,
        maxRetries: 0,
        endpointFlakeRuns: 3,
        boundaryConfirmRuns: 3,
        maxSkips: 10,
        confirmBeforeExecutingCode: false,
        cleanIgnored: false,
        allowlistedEnvVars: [],
        enforceNodeToolchainCheck: false,
        interactivePrompt: false,
      },
    },
    overlayHashes: {},
    skipCount: 0,
    testedRevisions: [],
    runnerVersion: "0.1.0",
    conclusion: {
      outcome: "candidate_confirmed",
      candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parentSha: "1111111111111111111111111111111111111111",
      skippedShas: [],
      explanation: "Culprit isolated.",
    },
  };
}

describe("Report Generation — Consecutive Evaluation Row Collapsing", () => {
  it("collapses unanimous consecutive evaluations into one row", () => {
    const evals = [
      {
        commitSha: "aaaaaaaa1111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok",
        gitExitCode: 0,
      },
      {
        commitSha: "aaaaaaaa1111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok",
        gitExitCode: 0,
      },
      {
        commitSha: "aaaaaaaa1111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok",
        gitExitCode: 0,
      },
    ];

    const collapsed = collapseConsecutiveEvaluations(evals);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]?.commitSha, "aaaaaaaa1111");
    assert.equal(collapsed[0]?.runCount, 3);
    assert.equal(collapsed[0]?.unanimous, true);
    assert.equal(collapsed[0]?.classificationSummary, "good · 3/3 runs");
    assert.equal(collapsed[0]?.primaryClassification, "good");
  });

  it("collapses mixed consecutive evaluations explicitly showing disagreement", () => {
    const evals = [
      {
        commitSha: "bbbbbbbb2222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "fail 1",
        gitExitCode: 1,
      },
      {
        commitSha: "bbbbbbbb2222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "fail 2",
        gitExitCode: 1,
      },
      {
        commitSha: "bbbbbbbb2222",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "pass 3",
        gitExitCode: 0,
      },
    ];

    const collapsed = collapseConsecutiveEvaluations(evals);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]?.commitSha, "bbbbbbbb2222");
    assert.equal(collapsed[0]?.runCount, 3);
    assert.equal(collapsed[0]?.unanimous, false);
    assert.equal(collapsed[0]?.classificationSummary, "2/3 bad, 1/3 good");
    assert.equal(collapsed[0]?.primaryClassification, "mixed");
    assert.match(collapsed[0]?.detail ?? "", /fail 1; fail 2; pass 3/);
  });

  it("does not collapse distinct adjacent commits", () => {
    const evals = [
      {
        commitSha: "111111111111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok",
        gitExitCode: 0,
      },
      {
        commitSha: "222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "fail",
        gitExitCode: 1,
      },
    ];

    const collapsed = collapseConsecutiveEvaluations(evals);
    assert.equal(collapsed.length, 2);
    assert.equal(collapsed[0]?.commitSha, "111111111111");
    assert.equal(collapsed[0]?.classificationSummary, "good");
    assert.equal(collapsed[1]?.commitSha, "222222222222");
    assert.equal(collapsed[1]?.classificationSummary, "bad");
  });

  it("preserves repeated evaluations separated by another commit without merging nonconsecutive rows", () => {
    const evals = [
      {
        commitSha: "aaaaaaaa1111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok 1",
        gitExitCode: 0,
      },
      {
        commitSha: "bbbbbbbb2222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "fail",
        gitExitCode: 1,
      },
      {
        commitSha: "aaaaaaaa1111",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "ok 2",
        gitExitCode: 0,
      },
    ];

    const collapsed = collapseConsecutiveEvaluations(evals);
    assert.equal(collapsed.length, 3);
    assert.equal(collapsed[0]?.commitSha, "aaaaaaaa1111");
    assert.equal(collapsed[1]?.commitSha, "bbbbbbbb2222");
    assert.equal(collapsed[2]?.commitSha, "aaaaaaaa1111");
  });

  it("renders collapsed rows in Markdown and HTML while leaving JSON evaluations uncollapsed", () => {
    const manifest = createTestManifest();
    const makeEv = (seq: number, sha: string, cls: "good" | "bad", detail: string): LedgerEvent => ({
      schemaVersion: 1,
      seq,
      sessionId: manifest.id,
      timestamp: new Date().toISOString(),
      prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
      eventHash: `hash-${seq}`,
      type: "revision_classified",
      commitSha: sha,
      classification: cls,
      reasonCode: cls === "good" ? "oracle_passed" : "oracle_failed_expected_regression",
      detail,
      gitExitCode: cls === "good" ? 0 : 1,
      overlayHashes: {},
    });

    const events: LedgerEvent[] = [
      makeEv(1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bad", "bad run 1"),
      makeEv(2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bad", "bad run 2"),
      makeEv(3, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "good", "flaky pass"),
      makeEv(4, "1111111111111111111111111111111111111111", "good", "good run 1"),
      makeEv(5, "1111111111111111111111111111111111111111", "good", "good run 2"),
      makeEv(6, "1111111111111111111111111111111111111111", "good", "good run 3"),
    ];

    // 1. JSON report: remains completely uncollapsed
    const jsonReport = generateJsonReport(manifest, events);
    assert.equal(jsonReport.evaluations.length, 6, "JSON report must preserve all 6 underlying evaluations");

    // 2. Markdown report: 2 rows
    const md = generateMarkdownReport(manifest, events);
    assert.match(md, /\|\s*`aaaaaaaa`\s*\|\s*\*\*2\/3 bad, 1\/3 good\*\*/);
    assert.match(md, /\|\s*`11111111`\s*\|\s*\*\*good · 3\/3 runs\*\*/);

    // 3. HTML report: contains collapsed badges
    const html = generateHtmlReport(manifest, events);
    assert.ok(html.includes("2/3 bad, 1/3 good"));
    assert.ok(html.includes("good · 3/3 runs"));
  });
});
