import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeSize,
  formatMinimizationReportJson,
  formatMinimizationReportMarkdown,
  minimizeInput,
  validateMinimizerPaths,
} from "../../src/domain/minimizer.js";
import { makeOutcome } from "../../src/domain/classification.js";
import { runCli } from "../../src/cli/index.js";

test("Feature A — Delta Debugging / Input Minimization", async (t) => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-minimizer-test-"));

  t.after(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Safe cleanup
    }
  });

  await t.test("path validation prevents directory traversal and accidental overwriting", () => {
    const inputFile = path.join(tmpRoot, "sample.txt");
    writeFileSync(inputFile, "hello\nworld\n", "utf-8");

    // Missing file throws
    assert.throws(() => {
      validateMinimizerPaths(path.join(tmpRoot, "nonexistent.txt"));
    }, /does not exist/);

    // Overwriting input without authorization throws
    assert.throws(() => {
      validateMinimizerPaths(inputFile, inputFile, false);
    }, /cannot overwrite input file without explicit authorization/);

    // Overwriting input with authorization passes
    const valid = validateMinimizerPaths(inputFile, inputFile, true);
    assert.equal(valid.resolvedInput, inputFile);
    assert.equal(valid.resolvedOutput, inputFile);
  });

  await t.test("reduces a known failure-inducing input to minimal failing lines", async () => {
    const inputFile = path.join(tmpRoot, "multiline.txt");
    const lines = [
      "alpha = 1",
      "beta = 2",
      "gamma = 3",
      "CRASH_TRIGGER_LINE",
      "delta = 4",
      "epsilon = 5",
      "zeta = 6",
    ];
    writeFileSync(inputFile, lines.join("\n") + "\n", "utf-8");
    const originalContent = readFileSync(inputFile, "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      customOracle: async (content) => {
        if (content.includes("CRASH_TRIGGER_LINE")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Target crash observed");
        }
        return makeOutcome("good", "oracle_passed", "No crash");
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedReason, "minimal");
    assert.equal(result.minimizedInput.trim(), "CRASH_TRIGGER_LINE");
    assert.equal(result.originalSize.lines, 7);
    assert.equal(result.minimizedSize.lines, 1);
    assert.ok(result.reductionRatio > 0.7);

    // Verify original input file is strictly preserved
    assert.equal(readFileSync(inputFile, "utf-8"), originalContent);
  });

  await t.test("handles input that cannot be reduced further (already 1-minimal)", async () => {
    const inputFile = path.join(tmpRoot, "single.txt");
    writeFileSync(inputFile, "CRITICAL_ERROR\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      customOracle: async (content) => {
        if (content.includes("CRITICAL_ERROR")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Critical error");
        }
        return makeOutcome("good", "oracle_passed", "OK");
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedReason, "minimal");
    assert.equal(result.minimizedInput, "CRITICAL_ERROR\n");
    assert.equal(result.reductionRatio, 0);
  });

  await t.test("aborts minimization if original input does not reproduce target failure (baseline check)", async () => {
    const inputFile = path.join(tmpRoot, "passing.txt");
    writeFileSync(inputFile, "clean input without bug\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      customOracle: async () => {
        // Returns "good" (does not reproduce failure)
        return makeOutcome("good", "oracle_passed", "Test passed");
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.stoppedReason, "baseline_failed");
    assert.equal(result.evaluationCount, 1);
    assert.ok(result.detail.includes("Baseline test did not reproduce target failure"));
  });

  await t.test("rejects candidate reductions that fail to preserve the target failure", async () => {
    const inputFile = path.join(tmpRoot, "dependencies.txt");
    // Failure requires BOTH line A and line B to be present
    writeFileSync(inputFile, ["init", "A_PART", "middle", "B_PART", "footer"].join("\n") + "\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      customOracle: async (content) => {
        if (content.includes("A_PART") && content.includes("B_PART")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Combined regression triggered");
        }
        return makeOutcome("good", "oracle_passed", "No failure");
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedReason, "minimal");
    // Minimized input must retain both A_PART and B_PART, but drop init, middle, footer
    assert.ok(result.minimizedInput.includes("A_PART"));
    assert.ok(result.minimizedInput.includes("B_PART"));
    assert.ok(!result.minimizedInput.includes("init"));
    assert.ok(!result.minimizedInput.includes("middle"));
    assert.ok(!result.minimizedInput.includes("footer"));
  });

  await t.test("halts gracefully when evaluation budget is exhausted", async () => {
    const inputFile = path.join(tmpRoot, "budget.txt");
    const lines = Array.from({ length: 30 }, (_, i) => `line_${i}`);
    lines[15] = "BUG_TARGET";
    writeFileSync(inputFile, lines.join("\n") + "\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      maxEvaluations: 4, // Intentionally low budget
      customOracle: async (content) => {
        if (content.includes("BUG_TARGET")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Bug hit");
        }
        return makeOutcome("good", "oracle_passed", "Clean");
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedReason, "budget_exhausted");
    assert.ok(result.evaluationCount <= 5);
    // Minimized input must still be a confirmed failure
    assert.ok(result.minimizedInput.includes("BUG_TARGET"));
  });

  await t.test("halts immediately upon abort signal cancellation", async () => {
    const inputFile = path.join(tmpRoot, "cancel.txt");
    writeFileSync(inputFile, "line1\nline2\nline3\nline4\nBUG\nline5\n", "utf-8");

    const controller = new AbortController();
    let count = 0;

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      abortSignal: controller.signal,
      customOracle: async (content) => {
        count++;
        if (count >= 2) {
          controller.abort();
        }
        if (content.includes("BUG")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Bug hit");
        }
        return makeOutcome("good", "oracle_passed", "Pass");
      },
    });

    assert.equal(result.stoppedReason, "cancelled");
    assert.ok(result.minimizedInput.includes("BUG"));
  });

  await t.test("handles noisy oracle mode with Bayesian confidence", async () => {
    const inputFile = path.join(tmpRoot, "noisy.txt");
    writeFileSync(inputFile, "part1\npart2\nNOISY_BUG\npart3\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      testCommand: "dummy",
      noisy: true,
      noisyConfidence: 0.85,
      customOracle: async (content) => {
        if (content.includes("NOISY_BUG")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Fail", "automated", {
            sampleCount: 3,
            passedRuns: 0,
            failedRuns: 3,
            skippedRuns: 0,
            posterior: 0.99,
            confidenceThreshold: 0.85,
          });
        }
        return makeOutcome("good", "oracle_passed", "Pass");
      },
    });

    assert.equal(result.success, true);
    assert.ok(result.minimizedInput.includes("NOISY_BUG"));
  });

  await t.test("writes minimized output to specified destination file", async () => {
    const inputFile = path.join(tmpRoot, "to_write.txt");
    const outputFile = path.join(tmpRoot, "minimized_output.txt");
    writeFileSync(inputFile, "junk1\njunk2\nCRASH\njunk3\n", "utf-8");

    const result = await minimizeInput({
      inputPath: inputFile,
      outputPath: outputFile,
      testCommand: "dummy",
      customOracle: async (content) => {
        if (content.includes("CRASH")) {
          return makeOutcome("bad", "oracle_failed_expected_regression", "Crash");
        }
        return makeOutcome("good", "oracle_passed", "OK");
      },
    });

    assert.equal(result.success, true);
    assert.equal(readFileSync(outputFile, "utf-8").trim(), "CRASH");
  });

  await t.test("generates markdown and JSON minimization reports", () => {
    const dummyResult = {
      success: true,
      inputPath: "/tmp/in.txt",
      outputPath: "/tmp/out.txt",
      originalInput: "line1\nline2\nline3\n",
      minimizedInput: "line2\n",
      originalSize: { lines: 3, bytes: 18 },
      minimizedSize: { lines: 1, bytes: 6 },
      reductionRatio: 0.6667,
      evaluationCount: 5,
      baselineOutcome: makeOutcome("bad", "oracle_failed_expected_regression", "Initial fail"),
      finalOutcome: makeOutcome("bad", "oracle_failed_expected_regression", "Final fail"),
      stoppedReason: "minimal" as const,
      detail: "Reduced successfully",
    };

    const jsonReport = formatMinimizationReportJson(dummyResult);
    assert.equal(jsonReport.schemaVersion, 1);
    assert.equal(jsonReport.reductionPercentage, 66.7);
    assert.equal(jsonReport.stoppedReason, "minimal");

    const mdReport = formatMinimizationReportMarkdown(dummyResult);
    assert.ok(mdReport.includes("# BisectPilot Input Minimization Report"));
    assert.ok(mdReport.includes("66.7%"));
    assert.ok(mdReport.includes("line2"));
  });

  await t.test("real process integration: minimizes a file using node child process", async () => {
    const testFile = path.join(tmpRoot, "real_process_input.txt");
    const testScript = path.join(tmpRoot, "test_runner.js");

    writeFileSync(testFile, ["entry1", "entry2", "ERROR_FLAG", "entry3", "entry4"].join("\n") + "\n", "utf-8");

    // Test runner script that exits with 1 if candidate input contains ERROR_FLAG
    writeFileSync(
      testScript,
      `
const fs = require('fs');
const targetFile = process.argv[2];
if (!targetFile || !fs.existsSync(targetFile)) process.exit(0);
const content = fs.readFileSync(targetFile, 'utf-8');
if (content.includes('ERROR_FLAG')) {
  process.exit(1); // Regression failure!
}
process.exit(0); // Pass
`,
      "utf-8"
    );

    const result = await minimizeInput({
      inputPath: testFile,
      testCommand: "node",
      testArgs: [testScript, "{input}"],
    });

    assert.equal(result.success, true);
    assert.equal(result.stoppedReason, "minimal");
    assert.equal(result.minimizedInput.trim(), "ERROR_FLAG");
    assert.equal(result.minimizedSize.lines, 1);
  });

  await t.test("CLI integration: bisectpilot minimize command execution", async () => {
    const cliInput = path.join(tmpRoot, "cli_input.txt");
    const cliOutput = path.join(tmpRoot, "cli_output.txt");
    writeFileSync(cliInput, "lineA\nFAIL_TOKEN\nlineB\n", "utf-8");

    // Missing test command gives code 2
    const codeMissingTest = await runCli(["minimize", cliInput]);
    assert.equal(codeMissingTest, 2);

    // Missing input gives code 2
    const codeMissingInput = await runCli(["minimize", "--test", "node"]);
    assert.equal(codeMissingInput, 2);

    // Successful CLI run with node -e using --arg flags
    const codeSuccess = await runCli([
      "minimize",
      cliInput,
      "--test",
      "node",
      "--arg",
      "-e",
      "--arg",
      "const fs = require('fs'); const file = process.argv[1]; if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('FAIL_TOKEN')) process.exit(1); process.exit(0);",
      "--out",
      cliOutput,
      "--json",
    ]);

    assert.equal(codeSuccess, 0);
    assert.equal(readFileSync(cliOutput, "utf-8").trim(), "FAIL_TOKEN");

  });
});
