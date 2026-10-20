import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendLedgerEvent } from "../../src/ledger/index.js";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../../src/cli/index.js";
import { FakeEngine } from "../../src/contracts/fake-engine.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

async function captureCliOutput(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("CLI — Dispatch & Command Behavior", () => {
  it("prints help and exits with 0 on --help", async () => {
    const code = await runCli(["--help"]);
    assert.equal(code, 0);
  });

  it("runs doctor check successfully on hermetic repository fixture even from non-git cwd", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "initial commit",
        files: { "package.json": '{"name":"test"}\n' },
      },
    ]);
    const nonGitDir = mkdtempSync(path.join(os.tmpdir(), "bp-nongit-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(nonGitDir);
      const code = await runCli(["doctor", fixture.repoDir]);
      assert.equal(code, 0);
    } finally {
      process.chdir(originalCwd);
      rmSync(nonGitDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("initializes a valid starter config file", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-cli-test-"));
    try {
      const cfgPath = path.join(tmpDir, "bisectpilot.config.json");
      const code = await runCli(["init", "--out", cfgPath]);
      assert.equal(code, 0);

      const parsed = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        schemaVersion: number;
        oracle: { mode: string };
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.oracle.mode, "in-tree");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects run/start when --config is missing", async () => {
    const code = await runCli(["run"]);
    assert.equal(code, 2);
  });

  it("includes --prompt in help output", async () => {
    let captured = "";
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      captured += chunk.toString();
      return true;
    }) as any;
    try {
      const code = await runCli(["--help"]);
      assert.equal(code, 0);
      assert.ok(captured.includes("--prompt"));
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("handles --prompt in start command with config", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-cli-prompt-"));
    try {
      const cfgPath = path.join(tmpDir, "bisectpilot.config.json");
      await runCli(["init", "--out", cfgPath]);
      // Run start without --yes should refuse with exit code 3
      const code = await runCli(["start", "--config", cfgPath, "--prompt"]);
      assert.equal(code, 3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prints only start help for start --help", async () => {
    let captured = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await runCli(["start", "--help"]), 0);
      assert.ok(captured.includes("--good"));
      assert.ok(!captured.includes("daemon start|status"));
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("prints a human-readable start summary and progress by default", async () => {
    const result = await captureCliOutput(() =>
      runCli(
        ["start", "--good", "good", "--bad", "bad", "--yes", "--", "node", "check.js"],
        new FakeEngine()
      )
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Session: fake-session-01/);
    assert.match(result.stdout, /Outcome: candidate_confirmed/);
    assert.match(result.stdout, /Candidate: 44444444/);
    assert.match(result.stdout, /Evaluated revisions: 1/);
    assert.ok(!result.stdout.includes("\u001b["));
    assert.match(result.stderr, /\[progress\] session fake-session-01 created/);
  });

  it("keeps start output machine-readable with --json", async () => {
    const result = await captureCliOutput(() =>
      runCli(
        ["start", "--good", "good", "--bad", "bad", "--yes", "--json", "--", "node", "check.js"],
        new FakeEngine()
      )
    );

    assert.equal(result.code, 0);
    const manifest = JSON.parse(result.stdout) as { id?: string; conclusion?: { outcome?: string } };
    assert.equal(manifest.id, "fake-session-01");
    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
    assert.match(result.stderr, /\[progress\] session fake-session-01 created/);
  });

  it("prints a human-readable resume summary by default", async () => {
    const engine = new FakeEngine();
    await runCli(["start", "--good", "good", "--bad", "bad", "--yes", "--json", "--", "node", "check.js"], engine);

    const result = await captureCliOutput(() => runCli(["resume", "fake-session-01"], engine));

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Session: fake-session-01/);
    assert.match(result.stdout, /Outcome: candidate_confirmed/);
    assert.match(result.stdout, /Candidate: 44444444/);
  });

  it("rejects unknown options for subcommands with exit code 2", async () => {
    for (const [subcmd, flag] of [
      [["doctor", "--unknown-flag"], "doctor"],
      [["status", "bp-1", "--unknown-flag"], "status"],
      [["report", "bp-1", "--unknown-flag"], "report"],
      [["cleanup", "bp-1", "--unknown-flag"], "cleanup"],
      [["list", "--unknown-flag"], "list"],
      [["daemon", "start", "--unknown-flag"], "daemon start"],
      [["worker", "status", "--unknown-flag"], "worker status"],
    ] as const) {
      const result = await captureCliOutput(() => runCli(subcmd as readonly string[]));
      assert.equal(result.code, 2, `Expected exit 2 for ${subcmd.join(" ")}`);
      assert.match(result.stderr, new RegExp(`${flag}.*unknown-flag`), `Expected error mentioning ${flag}`);
    }
  });

  it("validates numeric options strictly across subcommands", async () => {
    // start with invalid timeout
    const resTimeout = await captureCliOutput(() =>
      runCli(["start", "--good", "a", "--bad", "b", "--timeout=-5", "--", "npm", "test"])
    );
    assert.equal(resTimeout.code, 2);
    assert.match(resTimeout.stderr, /Invalid --timeout/);

    // start with invalid threshold
    const resThreshold = await captureCliOutput(() =>
      runCli(["start", "--good", "a", "--bad", "b", "--metric", "latency", "--threshold", "invalid", "--", "npm", "test"])
    );
    assert.equal(resThreshold.code, 2);
    assert.match(resThreshold.stderr, /Invalid --threshold/);

    // start with invalid alpha
    const resAlpha = await captureCliOutput(() =>
      runCli(["start", "--good", "a", "--bad", "b", "--metric", "latency", "--alpha", "0.99", "--", "npm", "test"])
    );
    assert.equal(resAlpha.code, 2);
    assert.match(resAlpha.stderr, /Invalid --alpha/);

    // start with invalid warmup
    const resWarmup = await captureCliOutput(() =>
      runCli(["start", "--good", "a", "--bad", "b", "--metric", "latency", "--warmup=-1", "--", "npm", "test"])
    );
    assert.equal(resWarmup.code, 2);
    assert.match(resWarmup.stderr, /Invalid --warmup/);

    // start with invalid samples
    const resSamples = await captureCliOutput(() =>
      runCli(["start", "--good", "a", "--bad", "b", "--metric", "latency", "--samples", "0", "--", "npm", "test"])
    );
    assert.equal(resSamples.code, 2);
    assert.match(resSamples.stderr, /Invalid --samples/);

    // minimize with invalid budget
    const resBudget = await captureCliOutput(() =>
      runCli(["minimize", "input.txt", "--test", "node", "--budget=-10"])
    );
    assert.equal(resBudget.code, 2);
    assert.match(resBudget.stderr, /Invalid --budget/);

    // daemon start with invalid port
    const resPort = await captureCliOutput(() =>
      runCli(["daemon", "start", "--port", "999999"])
    );
    assert.equal(resPort.code, 2);
    assert.match(resPort.stderr, /port.*must be between 1 and 65535/i);
  });

  it("confirms ledger verification on stderr and leaves stdout clean", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-ledger-test-"));
    try {
      const ledgerPath = path.join(tmpDir, "ledger.jsonl");
      appendLedgerEvent(ledgerPath, {
        sessionId: "verify-success-session",
        type: "session_created",
        goodSha: "11111111",
        badSha: "99999999",
        worktreePath: "/tmp/worktree",
        overlayHashes: {},
      });
      appendLedgerEvent(ledgerPath, {
        sessionId: "verify-success-session",
        type: "revision_classified",
        commitSha: "44444444",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "test failure",
        gitExitCode: 1,
        overlayHashes: {},
      });

      const engine = new FakeEngine();
      const baseManifest = await engine.start({
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: tmpDir,
        workingDirectory: ".",
        goodRef: "good",
        badRef: "bad",
        oracle: { mode: "in-tree", command: { command: "node", args: ["check.js"], timeoutMs: 1000 }, overlayConflictPolicy: "skip" },
        execution: {
          maxOutputBytesPerCommand: 1000,
          maxRetries: 0,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          maxSkips: 1,
          confirmBeforeExecutingCode: false,
          cleanIgnored: false,
          allowlistedEnvVars: [],
          enforceNodeToolchainCheck: false,
          interactivePrompt: false,
        },
      });
      engine.addSession({
        ...baseManifest,
        id: "verify-success-session",
        ledgerPath,
      });

      const result = await captureCliOutput(() =>
        runCli(["report", "verify-success-session", "--verify"], engine)
      );

      assert.equal(result.code, 0);
      assert.match(result.stderr, /OK Ledger verified: 2 events, hash chain intact/);
      assert.ok(!result.stdout.includes("Ledger verified"));
      assert.match(result.stdout, /BisectPilot Investigation Report.*verify-success-session/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails verification on tampered ledger and identifies broken seq", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-tamper-test-"));
    try {
      const ledgerPath = path.join(tmpDir, "ledger.jsonl");
      appendLedgerEvent(ledgerPath, {
        sessionId: "tampered-session",
        type: "session_created",
        goodSha: "11111111",
        badSha: "99999999",
        worktreePath: "/tmp/worktree",
        overlayHashes: {},
      });
      appendLedgerEvent(ledgerPath, {
        sessionId: "tampered-session",
        type: "revision_classified",
        commitSha: "44444444",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "test failure",
        gitExitCode: 1,
        overlayHashes: {},
      });

      // Tamper line 2
      const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
      const ev2 = JSON.parse(lines[1]!);
      ev2.commitSha = "00000000";
      lines[1] = JSON.stringify(ev2);
      writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf-8");

      const engine = new FakeEngine();
      const baseManifest = await engine.start({
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: tmpDir,
        workingDirectory: ".",
        goodRef: "good",
        badRef: "bad",
        oracle: { mode: "in-tree", command: { command: "node", args: ["check.js"], timeoutMs: 1000 }, overlayConflictPolicy: "skip" },
        execution: {
          maxOutputBytesPerCommand: 1000,
          maxRetries: 0,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          maxSkips: 1,
          confirmBeforeExecutingCode: false,
          cleanIgnored: false,
          allowlistedEnvVars: [],
          enforceNodeToolchainCheck: false,
          interactivePrompt: false,
        },
      });
      engine.addSession({
        ...baseManifest,
        id: "tampered-session",
        ledgerPath,
      });

      const result = await captureCliOutput(() =>
        runCli(["report", "tampered-session", "--verify"], engine)
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Ledger verification failed:.*seq 2/);
      assert.equal(result.stdout, "");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
