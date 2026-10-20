import test from "node:test";
import assert from "node:assert/strict";
import { terminateProcessTree } from "../../src/process/index.js";

test("Process-Tree Termination — Windows taskkill & POSIX kill behavior", async (t) => {
  await t.test("Windows win32 platform sends taskkill signal", () => {
    let sentSignal: string | null = null;
    terminateProcessTree(
      12345,
      5000,
      (sig) => {
        sentSignal = sig;
      },
      "win32"
    );
    assert.equal(sentSignal, "taskkill");
  });

  await t.test("POSIX platforms send SIGTERM initially", () => {
    let sentSignal: string | null = null;
    terminateProcessTree(
      999999999, // Non-existent PID to safely trigger try/catch
      100,
      (sig) => {
        sentSignal = sig;
      },
      "darwin"
    );
    assert.equal(sentSignal, "SIGTERM");
  });
});
