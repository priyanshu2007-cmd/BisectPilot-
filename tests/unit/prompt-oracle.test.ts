import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  evaluateCheckedOutRevision,
  makeOutcome,
  promptHumanClassification,
  readLedgerEvents,
  type BisectConfigV1,
} from "../../src/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

describe("Step 3 Feature A — Interactive Oracle Classification (--prompt)", () => {
  it("classifies revision as good when operator selects 'g'", async () => {
    const input = Readable.from(["g\n"]);
    let outputData = "";
    const output = new PassThrough();
    output.on("data", (c) => {
      outputData += c.toString();
    });

    const autoOutcome = makeOutcome("bad", "oracle_failed_expected_regression", "Exit code 1");
    const outcome = await promptHumanClassification({
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "good");
    assert.equal(outcome.reasonCode, "oracle_passed");
    assert.equal(outcome.gitExitCode, 0);
    assert.equal(outcome.classifiedBy, "human");
    assert.ok(outputData.includes("=== BisectPilot Interactive Oracle Prompt ==="));
    assert.ok(outputData.includes("12345678"));
  });

  it("classifies revision as bad when operator selects 'b'", async () => {
    const input = Readable.from(["b\n"]);
    const output = new PassThrough();

    const autoOutcome = makeOutcome("good", "oracle_passed", "Exit code 0");
    const outcome = await promptHumanClassification({
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "bad");
    assert.equal(outcome.gitExitCode, 1);
    assert.equal(outcome.classifiedBy, "human");
  });

  it("classifies revision as skip when operator selects 's'", async () => {
    const input = Readable.from(["s\n"]);
    const output = new PassThrough();

    const autoOutcome = makeOutcome("bad", "oracle_failed_expected_regression", "Exit code 1");
    const outcome = await promptHumanClassification({
      commitSha: "feedbeef1234567890abcdef1234567890abcdef",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "skip");
    assert.equal(outcome.gitExitCode, 125);
    assert.equal(outcome.classifiedBy, "human");
  });

  it("retries upon invalid input until a valid choice is entered", async () => {
    const input = Readable.from(["maybe\n", "xyz\n", "good\n"]);
    let outputData = "";
    const output = new PassThrough();
    output.on("data", (c) => {
      outputData += c.toString();
    });

    const autoOutcome = makeOutcome("skip", "timeout", "timed out");
    const outcome = await promptHumanClassification({
      commitSha: "1111222233334444555566667777888899990000",
      commandSpec: { command: "node", args: ["test.js"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "good");
    assert.equal(outcome.classifiedBy, "human");
    assert.ok(outputData.includes('Invalid choice "maybe"'));
    assert.ok(outputData.includes('Invalid choice "xyz"'));
  });

  it("handles EOF stream close gracefully by falling back to automated classification", async () => {
    const input = Readable.from([]); // immediate EOF
    const output = new PassThrough();

    const autoOutcome = makeOutcome("bad", "oracle_failed_expected_regression", "Exit code 1");
    const outcome = await promptHumanClassification({
      commitSha: "aaaa111122223333444455556666777788889999",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "bad");
    assert.equal(outcome.classifiedBy, "automated");
  });

  it("handles cancellation safely without hanging", async () => {
    const abortController = new AbortController();
    abortController.abort(); // already aborted

    const input = new PassThrough();
    const output = new PassThrough();

    const autoOutcome = makeOutcome("good", "oracle_passed", "Exit code 0");
    const outcome = await promptHumanClassification({
      commitSha: "cccc111122223333444455556666777788889999",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      abortSignal: abortController.signal,
      streams: { input, output, isTTY: true },
    });

    assert.equal(outcome.kind, "abort");
    assert.equal(outcome.reasonCode, "cancelled");
  });

  it("falls back to automated classification immediately when stdin is non-interactive", async () => {
    const input = new PassThrough(); // Has no data, but non-interactive flag is false
    let outputData = "";
    const output = new PassThrough();
    output.on("data", (c) => {
      outputData += c.toString();
    });

    const autoOutcome = makeOutcome("skip", "timeout", "timed out");
    const outcome = await promptHumanClassification({
      commitSha: "bbbb111122223333444455556666777788889999",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      streams: { input, output, isTTY: false },
    });

    assert.equal(outcome.kind, "skip");
    assert.equal(outcome.reasonCode, "timeout");
    assert.equal(outcome.classifiedBy, "automated");
    assert.ok(outputData.includes("Stdin is non-interactive"));
  });

  it("redacts sensitive tokens in displayed command, output and executionInfo", async () => {
    const input = Readable.from(["g\n"]);
    let outputData = "";
    const output = new PassThrough();
    output.on("data", (c) => {
      outputData += c.toString();
    });

    const autoOutcome = makeOutcome(
      "bad",
      "oracle_failed_expected_regression",
      "Failure with key sk-abcdef12345678901234567890"
    );
    await promptHumanClassification({
      commitSha: "deadbeef1234567890abcdef1234567890abcdef",
      commandSpec: { command: "npm", args: ["test"], timeoutMs: 5000 },
      automatedOutcome: autoOutcome,
      capturedOutput: {
        stdout: "Token leaked: ghp_11112222333344445555666677778888\n",
        stderr: "Authorization: Bearer mySecretToken123\n",
      },
      streams: { input, output, isTTY: true },
    });

    assert.ok(!outputData.includes("ghp_11112222333344445555666677778888"));
    assert.ok(outputData.includes("[REDACTED_GITHUB_TOKEN]"));
    assert.ok(!outputData.includes("sk-abcdef12345678901234567890"));
    assert.ok(outputData.includes("[REDACTED_API_KEY]"));
    assert.ok(!outputData.includes("mySecretToken123"));
    assert.ok(outputData.includes("[REDACTED_BEARER]"));
  });

  it("records classifiedBy: 'human' in ledger events when evaluated under interactivePrompt", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1",
        files: { "check.mjs": "process.exit(1);\n" },
      },
    ]);

    try {
      const sessionDir = path.join(fixture.tmpRoot, "session");
      const ledgerPath = path.join(sessionDir, "ledger.jsonl");

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[0]!,
        oracle: {
          mode: "in-tree",
          command: { command: "node", args: ["check.mjs"], timeoutMs: 5000 },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          interactivePrompt: true,
        },
      };

      const input = Readable.from(["g\n"]); // human overrides bad to good
      const output = new PassThrough();

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-interactive-test",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes: {},
        promptStreams: { input, output, isTTY: true },
      });

      assert.equal(outcome.kind, "good");
      assert.equal(outcome.classifiedBy, "human");

      const events = readLedgerEvents(ledgerPath);
      const classified = events.find((e) => e.type === "revision_classified");
      assert.ok(classified);
      assert.equal(classified.classification, "good");
      assert.equal(classified.classifiedBy, "human");
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves automated classification when interactivePrompt is false", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1",
        files: { "check.mjs": "process.exit(0);\n" },
      },
    ]);

    try {
      const sessionDir = path.join(fixture.tmpRoot, "session");
      const ledgerPath = path.join(sessionDir, "ledger.jsonl");

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[0]!,
        oracle: {
          mode: "in-tree",
          command: { command: "node", args: ["check.mjs"], timeoutMs: 5000 },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          interactivePrompt: false,
        },
      };

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-auto-test",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes: {},
      });

      assert.equal(outcome.kind, "good");
      assert.equal(outcome.classifiedBy, "automated");

      const events = readLedgerEvents(ledgerPath);
      const classified = events.find((e) => e.type === "revision_classified");
      assert.ok(classified);
      assert.equal(classified.classification, "good");
      assert.equal(classified.classifiedBy, "automated");
    } finally {
      fixture.cleanup();
    }
  });
});
