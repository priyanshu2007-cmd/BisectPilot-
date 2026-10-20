import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../../src/cli/index.js";

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
});
