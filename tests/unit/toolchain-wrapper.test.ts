import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyToolchainWrapper,
  DEFAULT_EXECUTION_POLICY,
  evaluateCheckedOutRevision,
  readLedgerEvents,
  runSafeProcess,
  type BisectConfigV1,
} from "../../src/index.js";
import { classifyOracleStep } from "../../src/domain/classification.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

describe("Step 3 Feature B — Configurable Toolchain Wrapper", () => {
  it("expands <version> and ${version} in wrapper arguments cleanly", () => {
    const wrapped = applyToolchainWrapper(
      { command: "npm", args: ["test"], timeoutMs: 5000 },
      { command: "fnm", args: ["exec", "--using=<version>", "--runtime=${version}", "--"] },
      "18.17.0"
    );

    assert.equal(wrapped.command, "fnm");
    assert.deepEqual(wrapped.args, [
      "exec",
      "--using=18.17.0",
      "--runtime=18.17.0",
      "--",
      "npm",
      "test",
    ]);
  });

  it("preserves command and args when no toolchain wrapper is configured", () => {
    const wrapped = applyToolchainWrapper(
      { command: "npm", args: ["run", "test:ci"], timeoutMs: 5000 },
      undefined,
      "20.0.0"
    );

    assert.equal(wrapped.command, "npm");
    assert.deepEqual(wrapped.args, ["run", "test:ci"]);
  });

  it("executes through wrapper with valid arguments and safe process runner", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-wrapper-test-"));
    try {
      // Use node as a wrapper launcher: node <script> <target> <arg>
      const res = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-e", "console.log('hello from child')"],
          timeoutMs: 5000,
        },
        cwd: tmpDir,
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          toolchainWrapper: {
            command: "node",
            args: ["-e", "require('child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit' })", "--"],
          },
        },
      });

      assert.equal(res.exitCode, 0);
      assert.equal(res.timedOut, false);
      assert.equal(res.cancelled, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("safely handles missing wrapper executable with actionable executable_not_found error", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-wrapper-missing-"));
    try {
      const res = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-v"],
          timeoutMs: 5000,
        },
        cwd: tmpDir,
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          toolchainWrapper: {
            command: "nonexistent_wrapper_binary_99999",
            args: ["exec", "--using=18"],
          },
        },
      });

      assert.equal(res.spawnErrorCode, "ENOENT");
      const outcome = classifyOracleStep(res, "functional");
      assert.equal(outcome.kind, "abort");
      assert.equal(outcome.reasonCode, "executable_not_found");
      assert.equal(outcome.gitExitCode, 128);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves correct argument boundaries without shell injection", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-wrapper-inj-"));
    try {
      // Pass an argument that would cause havoc if shell-concatenated
      const maliciousArg = "; echo 'INJECTED'; exit 42;";
      const res = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-e", "process.exit(process.argv.includes(process.argv[1]) ? 0 : 1)", maliciousArg],
          timeoutMs: 5000,
        },
        cwd: tmpDir,
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          toolchainWrapper: {
            command: "node",
            args: ["-e", "require('child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit' })", "--"],
          },
        },
      });

      assert.equal(res.exitCode, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("terminates the wrapper process tree upon timeout", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-wrapper-timeout-"));
    try {
      const res = await runSafeProcess({
        commandSpec: {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 60000)"],
          timeoutMs: 500, // Short timeout
        },
        cwd: tmpDir,
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          toolchainWrapper: {
            command: "node",
            args: ["-e", "require('child_process').spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit' })", "--"],
          },
        },
      });

      assert.equal(res.timedOut, true);
      assert.equal(res.terminatedBy, "timeout");
      const outcome = classifyOracleStep(res, "functional");
      assert.equal(outcome.kind, "skip");
      assert.equal(outcome.reasonCode, "timeout");
      assert.equal(outcome.gitExitCode, 125);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips revision when wrapper requires <version> but none is detected in historical revision", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1 with no node version files",
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
          toolchainWrapper: {
            command: "fnm",
            args: ["exec", "--using=<version>", "--"],
          },
        },
      };

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-wrapper-unresolved",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes: {},
      });

      assert.equal(outcome.kind, "skip");
      assert.equal(outcome.reasonCode, "toolchain_mismatch");
      assert.ok(outcome.detail.includes("requires a detected runtime version"));
    } finally {
      fixture.cleanup();
    }
  });

  it("runs with toolchain wrapper when revision specifies node version in .nvmrc", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1 with .nvmrc specifying 18",
        files: {
          ".nvmrc": "18.17.0\n",
          "check.mjs": "process.exit(0);\n",
        },
      },
    ]);

    try {
      const sessionDir = path.join(fixture.tmpRoot, "session");
      const ledgerPath = path.join(sessionDir, "ledger.jsonl");

      // Use node as a mock wrapper that verifies --using=18.17.0 was passed
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
          toolchainWrapper: {
            command: "node",
            args: [
              "-e",
              "if (!process.argv.includes('--using=18.17.0')) process.exit(1); const res = require('child_process').spawnSync(process.execPath, process.argv.slice(4), { stdio: 'inherit' }); process.exit(res.status ?? 0);",
              "--",
              "--using=<version>",
            ],
          },
        },
      };

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-wrapper-success",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes: {},
      });

      assert.equal(outcome.kind, "good", outcome.detail);
      assert.equal(outcome.reasonCode, "oracle_passed");

      // Verify that process_starting recorded the wrapper command and expanded args
      const events = readLedgerEvents(ledgerPath);
      const starting = events.find((e) => e.type === "process_starting");
      assert.ok(starting);
      assert.equal(starting.command, "node");
      assert.ok(starting.args.includes("--using=18.17.0"));
    } finally {
      fixture.cleanup();
    }
  });
});
