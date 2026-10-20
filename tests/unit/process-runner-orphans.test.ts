import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSafeProcess } from "../../src/adapters/process/process-runner.js";
import { DEFAULT_EXECUTION_POLICY } from "../../src/contracts/config.js";

test("Process Runner Background Orphan Cleanup Suite", async (t) => {
  const isPosix = process.platform !== "win32";

  await t.test("command that exits 1 leaving background child is not misclassified as timeout", async () => {
    if (!isPosix) return; // Guarded for POSIX

    const pidFile = path.join(os.tmpdir(), `bp-orphan-1-${Date.now()}.pid`);
    const startTime = Date.now();
    const result = await runSafeProcess({
      commandSpec: {
        command: "sh",
        args: ["-c", `sleep 20 & echo $! > "${pidFile}" && exit 1`],
        timeoutMs: 4000,
      },
      cwd: os.tmpdir(),
      executionPolicy: {
        ...DEFAULT_EXECUTION_POLICY,
        maxOutputBytesPerCommand: 1000,
        allowlistedEnvVars: [],
      },
      killGraceMs: 500,
    });

    const elapsed = Date.now() - startTime;
    assert.strictEqual(result.exitCode, 1, "Exit code should be 1 from main process");
    assert.strictEqual(result.timedOut, false, "Should not be timedOut");
    assert.strictEqual(result.cancelled, false, "Should not be cancelled");
    assert.strictEqual(result.orphanedProcessesKilled, true, "Should report orphanedProcessesKilled");
    assert.ok(elapsed < 2500, `Should complete fast under timeout (took ${elapsed}ms)`);

    // Verify the background sleep process is gone
    try {
      const bgPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      assert.ok(bgPid > 0, "Background PID must have been written");
      let processAlive = true;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(bgPid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          processAlive = false;
          break;
        }
      }
      assert.strictEqual(processAlive, false, "Background sleep 20 process should be gone");
    } finally {
      try {
        rmSync(pidFile, { force: true });
      } catch {
        // Ignore
      }
    }
  });

  await t.test("command that exits 0 leaving background child is not misclassified as timeout", async () => {
    if (!isPosix) return;

    const pidFile = path.join(os.tmpdir(), `bp-orphan-0-${Date.now()}.pid`);
    const startTime = Date.now();
    const result = await runSafeProcess({
      commandSpec: {
        command: "sh",
        args: ["-c", `sleep 20 & echo $! > "${pidFile}" && exit 0`],
        timeoutMs: 4000,
      },
      cwd: os.tmpdir(),
      executionPolicy: {
        ...DEFAULT_EXECUTION_POLICY,
        maxOutputBytesPerCommand: 1000,
        allowlistedEnvVars: [],
      },
      killGraceMs: 500,
    });

    const elapsed = Date.now() - startTime;
    assert.strictEqual(result.exitCode, 0, "Exit code should be 0 from main process");
    assert.strictEqual(result.timedOut, false, "Should not be timedOut");
    assert.strictEqual(result.cancelled, false, "Should not be cancelled");
    assert.strictEqual(result.orphanedProcessesKilled, true, "Should report orphanedProcessesKilled");
    assert.ok(elapsed < 2500, `Should complete fast under timeout (took ${elapsed}ms)`);

    // Verify the background sleep process is gone
    try {
      const bgPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      assert.ok(bgPid > 0, "Background PID must have been written");
      let processAlive = true;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(bgPid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          processAlive = false;
          break;
        }
      }
      assert.strictEqual(processAlive, false, "Background sleep 20 process should be gone");
    } finally {
      try {
        rmSync(pidFile, { force: true });
      } catch {
        // Ignore
      }
    }
  });
});
