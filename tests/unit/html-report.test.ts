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
  escapeHtml,
  generateHtmlReport,
  writeSessionReportArtifacts,
} from "../../src/reports/index.js";

function createMockManifest(overrides?: Partial<SessionManifestV1>): SessionManifestV1 {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-html-test-"));
  return {
    schemaVersion: 1,
    id: "bp-test-session-html",
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
      explanation: "Found regression commit.",
    },
    ...overrides,
  };
}

test("Feature A — Standalone Interactive HTML Report", async (t) => {
  await t.test("generates self-contained HTML with required content and zero remote dependencies", () => {
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
        detail: "AssertionError: expected true but got false",
        gitExitCode: 1,
        overlayHashes: {},
      },
    ];

    const html = generateHtmlReport(manifest, events);

    // Structure checks
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en">/);
    assert.ok(html.includes("BisectPilot Report — bp-test-session-html"));
    assert.ok(html.includes("candidate_confirmed"));
    assert.ok(html.includes("22222222"));
    assert.ok(html.includes("11111111"));
    assert.ok(html.includes("AssertionError: expected true but got false"));

    // Completely offline / zero remote calls check
    assert.strictEqual(
      html.includes("https://"),
      false,
      "HTML report must not contain any remote https:// links"
    );
    assert.strictEqual(
      html.includes("http://"),
      false,
      "HTML report must not contain any remote http:// links"
    );
    assert.strictEqual(
      html.includes("fonts.googleapis.com"),
      false,
      "HTML report must not reference external Google fonts"
    );
    assert.strictEqual(
      html.includes("cdn."),
      false,
      "HTML report must not reference external CDNs"
    );

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("safely escapes HTML and script breakout payloads (XSS protection)", () => {
    const maliciousMsg = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';
    const manifest = createMockManifest({
      conclusion: {
        outcome: "candidate_confirmed",
        candidateSha: "2222222222222222222222222222222222222222",
        parentSha: "1111111111111111111111111111111111111111",
        skippedShas: [],
        explanation: maliciousMsg,
      },
    });

    const events: LedgerEvent[] = [
      {
        schemaVersion: 1,
        seq: 1,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        eventHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        type: "revision_classified",
        commitSha: "2222222222222222222222222222222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: maliciousMsg,
        gitExitCode: 1,
        overlayHashes: {},
      },
    ];

    const html = generateHtmlReport(manifest, events);

    // Assert literal malicious tag is never rendered raw into HTML
    assert.strictEqual(
      html.includes("<script>alert(\"XSS\")</script>"),
      false,
      "Raw script tags must never appear in generated HTML"
    );
    assert.ok(html.includes("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));

    // Inside script block, < is escaped as \u003c
    assert.ok(html.includes("\\u003cscript>"));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("redacts sensitive tokens in output", () => {
    const sensitiveDetail = "Authorization failure: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 and secret sk-1234567890abcdefghijklmn";
    const manifest = createMockManifest();
    const events: LedgerEvent[] = [
      {
        schemaVersion: 1,
        seq: 1,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        eventHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        type: "revision_classified",
        commitSha: "2222222222222222222222222222222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: sensitiveDetail,
        gitExitCode: 1,
        overlayHashes: {},
      },
    ];

    const html = generateHtmlReport(manifest, events);
    assert.strictEqual(html.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), false);
    assert.strictEqual(html.includes("sk-1234567890abcdefghijklmn"), false);
    assert.ok(html.includes("[REDACTED_GITHUB_TOKEN]"));
    assert.ok(html.includes("[REDACTED_API_KEY]"));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("handles custom terms, noisy oracle metadata, and manual classifications", () => {
    const manifest = createMockManifest({
      config: {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: "/tmp",
        workingDirectory: ".",
        goodRef: "v1.0",
        badRef: "v2.0",
        terms: { old: "fast", new: "slow" },
        oracle: {
          mode: "in-tree",
          command: { command: "npm", args: ["test"], timeoutMs: 30_000 },
        },
        execution: DEFAULT_EXECUTION_POLICY,
      },
    });

    const events: LedgerEvent[] = [
      {
        schemaVersion: 1,
        seq: 1,
        sessionId: manifest.id,
        timestamp: new Date().toISOString(),
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        eventHash: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        type: "revision_classified",
        commitSha: "2222222222222222222222222222222222222222",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "bench regression",
        gitExitCode: 1,
        overlayHashes: {},
        classifiedBy: "human",
        noisySampling: {
          sampleCount: 5,
          passedRuns: 1,
          failedRuns: 4,
          skippedRuns: 0,
          posterior: 0.94,
          confidenceThreshold: 0.90,
        },
      },
    ];

    const html = generateHtmlReport(manifest, events);
    assert.ok(html.includes("First slow Commit"));
    assert.ok(html.includes("Fast Parent"));
    assert.ok(html.includes("manual"));
    assert.ok(html.includes("noisy (5 runs)"));
    assert.ok(html.includes("P(bad)=0.94"));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });

  await t.test("writeSessionReportArtifacts writes report.html to disk", () => {
    const manifest = createMockManifest();
    const artifacts = writeSessionReportArtifacts({
      manifest,
      events: [],
    });

    assert.ok(existsSync(artifacts.htmlPath));
    const content = readFileSync(artifacts.htmlPath, "utf-8");
    assert.match(content, /^<!DOCTYPE html>/);
    assert.ok(content.includes(manifest.id));

    rmSync(manifest.sessionDir, { recursive: true, force: true });
  });
});
