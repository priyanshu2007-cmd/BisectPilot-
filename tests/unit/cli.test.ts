import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../../src/cli/index.js";
import { FakeEngine } from "../../src/contracts/fake-engine.js";

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

  it("runs doctor check successfully on current repository", async () => {
    const code = await runCli(["doctor", "."]);
    assert.equal(code, 0);
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
});
