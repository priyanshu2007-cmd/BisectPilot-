import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY } from "../../src/config/index.js";
import {
  classifyBuildStep,
  classifyOracleStep,
  classifyPrepareStep,
} from "../../src/domain/index.js";
import { appendLedgerEvent, readLedgerEvents, verifyLedgerChain } from "../../src/ledger/index.js";
import { buildRestrictedEnvironment, runSafeProcess } from "../../src/process/index.js";
import { redactSensitiveText } from "../../src/reports/index.js";

describe("A3, A5, A7 — Process Runner, Classifier, Ledger Chain & Redaction", () => {
  it("enforces deterministic environment defaults and strips unallowlisted secrets", () => {
    const fakeParentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      OPENAI_API_KEY: "sk-secret12345678901234567890",
      GITHUB_TOKEN: "ghp_secret12345678901234567890",
      CUSTOM_ALLOWED: "yes",
    };
    const env = buildRestrictedEnvironment(
      { ...DEFAULT_EXECUTION_POLICY, allowlistedEnvVars: ["CUSTOM_ALLOWED"] },
      fakeParentEnv
    );
    assert.equal(env.CI, "1");
    assert.equal(env.TZ, "UTC");
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.CUSTOM_ALLOWED, "yes");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });

  it("caps large output, kills timed-out process trees, and never classifies timeout or missing executable as bad", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-proc-"));
    try {
      // 1. Missing executable -> ENOENT -> abort (128), never bad (1)
      const missingRes = await runSafeProcess({
        commandSpec: {
          command: "nonexistent_binary_xyz_999",
          args: [],
          timeoutMs: 2000,
        },
        cwd: tmpDir,
        executionPolicy: DEFAULT_EXECUTION_POLICY,
      });
      const missingOutcome = classifyOracleStep(missingRes, "functional");
      assert.equal(missingOutcome.kind, "abort");
      assert.equal(missingOutcome.reasonCode, "executable_not_found");
      assert.equal(missingOutcome.gitExitCode, 128);

      // 2. Exit codes 126 and 127 from child -> abort (128), never 126/127 or bad (1)
      const exit127Res = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-e", "process.exit(127)"],
          timeoutMs: 2000,
        },
        cwd: tmpDir,
        executionPolicy: DEFAULT_EXECUTION_POLICY,
      });
      const outcome127 = classifyOracleStep(exit127Res, "functional");
      assert.equal(outcome127.kind, "abort");
      assert.equal(outcome127.gitExitCode, 128);

      // 3. Timeout with grandchild process -> kills process group and classifies as skip (125)
      const pidFile = path.join(tmpDir, "grandchild.pid");
      const timeoutRes = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: [
            "-e",
            `const { spawn } = require("node:child_process");
             const fs = require("node:fs");
             const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
             fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
             setInterval(() => {}, 1000);`,
          ],
          timeoutMs: 150,
        },
        cwd: tmpDir,
        executionPolicy: DEFAULT_EXECUTION_POLICY,
        killGraceMs: 100,
      });
      assert.equal(timeoutRes.timedOut, true);
      const timeoutOutcome = classifyOracleStep(timeoutRes, "functional");
      assert.equal(timeoutOutcome.kind, "skip");
      assert.equal(timeoutOutcome.reasonCode, "timeout");
      assert.equal(timeoutOutcome.gitExitCode, 125);

      if (existsSyncSafe(pidFile)) {
        const grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
        await new Promise((r) => setTimeout(r, 150));
        let alive = false;
        try {
          process.kill(grandchildPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        assert.equal(alive, false, "Grandchild process should be terminated with process group");
      }

      // 4. Output capping at 4096 bytes
      const capRes = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-e", "process.stdout.write('A'.repeat(20000))"],
          timeoutMs: 2000,
        },
        cwd: tmpDir,
        executionPolicy: { ...DEFAULT_EXECUTION_POLICY, maxOutputBytesPerCommand: 4096 },
      });
      assert.equal(capRes.truncatedStdout, true);
      assert.equal(Buffer.byteLength(capRes.stdout), 4096);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies prepare, build, and functional/build profiles accurately", () => {
    const baseRes = {
      executable: "node",
      args: [],
      exitCode: 1,
      signal: null,
      durationMs: 10,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: "",
      truncatedStdout: false,
      truncatedStderr: false,
      stdoutSha256: "00",
      stderrSha256: "00",
    };

    const prepFail = classifyPrepareStep(baseRes);
    assert.equal(prepFail?.kind, "skip");
    assert.equal(prepFail?.reasonCode, "prepare_failed");
    assert.equal(prepFail?.gitExitCode, 125);

    const buildFailFunctional = classifyBuildStep(baseRes, "functional");
    assert.equal(buildFailFunctional?.kind, "skip");
    assert.equal(buildFailFunctional?.reasonCode, "build_prerequisite_failed");

    const buildFailBuildProfile = classifyBuildStep(baseRes, "build");
    assert.equal(buildFailBuildProfile?.kind, "bad");
    assert.equal(buildFailBuildProfile?.reasonCode, "build_regression_failed");
    assert.equal(buildFailBuildProfile?.gitExitCode, 1);
  });

  it("maintains a tamper-evident hash chain in the JSONL ledger and redacts secrets", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-ledger-"));
    try {
      const ledgerPath = path.join(tmpDir, "ledger.jsonl");
      appendLedgerEvent(ledgerPath, {
        type: "session_created",
        sessionId: "s1",
        goodSha: "1".repeat(40),
        badSha: "2".repeat(40),
        worktreePath: "/tmp/wt",
        overlayHashes: {},
      });
      appendLedgerEvent(ledgerPath, {
        type: "transition",
        sessionId: "s1",
        from: "created",
        to: "worktree_ready",
      });

      const events = readLedgerEvents(ledgerPath);
      assert.equal(events.length, 2);
      assert.equal(verifyLedgerChain(events).valid, true);

      // Tamper with line 1
      const rawLines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
      const firstObj = JSON.parse(rawLines[0]!) as Record<string, unknown>;
      firstObj.worktreePath = "/tmp/tampered";
      writeFileSync(ledgerPath, [JSON.stringify(firstObj), rawLines[1]!].join("\n") + "\n", "utf-8");

      const tamperedEvents = readLedgerEvents(ledgerPath);
      const check = verifyLedgerChain(tamperedEvents);
      assert.equal(check.valid, false);
      assert.equal(check.brokenAtSeq, 1);

      const redacted = redactSensitiveText(
        "Token ghp_1234567890abcdefghijklmnopqrstuv and Authorization: Bearer secret_jwt_token"
      );
      assert.ok(!redacted.includes("ghp_1234567890"));
      assert.ok(!redacted.includes("secret_jwt_token"));
      assert.ok(redacted.includes("[REDACTED_GITHUB_TOKEN]"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
