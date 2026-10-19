import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  evaluateCheckedOutRevision,
  LocalBisectEngine,
  readLedgerEvents,
  snapshotOverlayFiles,
  type BisectConfigV1,
} from "../../src/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

describe("Safety Suite — Overlay Conflicts, Toolchain Mismatch, Tracked-File Mutation & Cancellation", () => {
  it("refuses to overwrite tracked files in overlay mode and records overlay_conflicts_with_tracked_file", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1 with tracked check.mjs",
        files: { "check.mjs": "process.exit(0);\n" },
      },
      {
        message: "C2",
        files: { "check.mjs": "process.exit(1);\n" },
      },
    ]);

    try {
      const sessionDir = path.join(fixture.tmpRoot, "session");
      const ledgerPath = path.join(sessionDir, "ledger.jsonl");
      const overlayHashes = snapshotOverlayFiles(fixture.repoDir, sessionDir, ["check.mjs"]);

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[1]!,
        oracle: {
          mode: "overlay",
          command: { command: "node", args: ["check.mjs"], timeoutMs: 5000 },
          overlayFiles: ["check.mjs"],
          overlayConflictPolicy: "skip",
        },
        execution: DEFAULT_EXECUTION_POLICY,
      };

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-conflict",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes,
      });

      assert.equal(outcome.kind, "skip");
      assert.equal(outcome.reasonCode, "overlay_conflicts_with_tracked_file");
      assert.equal(outcome.gitExitCode, 125);
    } finally {
      fixture.cleanup();
    }
  });

  it("skips revisions whose .nvmrc major version mismatches the running Node runtime", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1 requiring Node 10",
        files: {
          ".nvmrc": "v10.24.1\n",
          "test.mjs": "process.exit(0);\n",
        },
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
          command: { command: "node", args: ["test.mjs"], timeoutMs: 5000 },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          enforceNodeToolchainCheck: true,
        },
      };

      const outcome = await evaluateCheckedOutRevision({
        sessionId: "s-nvmrc",
        sessionDir,
        ledgerPath,
        worktreePath: fixture.repoDir,
        commitSha: fixture.commitShas[0]!,
        config,
        overlayHashes: {},
      });

      assert.equal(outcome.kind, "skip");
      assert.equal(outcome.reasonCode, "toolchain_mismatch");
      assert.equal(outcome.gitExitCode, 125);
    } finally {
      fixture.cleanup();
    }
  });

  it("resets tracked files mutated by tests between revisions and supports AbortSignal cancellation", async () => {
    const fixture = await buildFixtureRepo([
      {
        message: "C1 good (mutates tracked lockfile)",
        files: {
          "lock.json": '{"v":1}\n',
          "test.mjs":
            'import fs from "node:fs"; fs.writeFileSync("lock.json", "mutated\\n"); process.exit(0);\n',
        },
      },
      {
        message: "C2 bad (mutates tracked lockfile)",
        files: {
          "lock.json": '{"v":2}\n',
          "test.mjs":
            'import fs from "node:fs"; fs.writeFileSync("lock.json", "mutated\\n"); process.exit(1);\n',
        },
      },
    ]);

    try {
      const sessionsRoot = path.join(fixture.tmpRoot, "sessions");
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[1]!,
        oracle: {
          mode: "in-tree",
          command: { command: "node", args: ["test.mjs"], timeoutMs: 5000 },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: sessionsRoot,
      };

      const engine = new LocalBisectEngine();
      const completed = await engine.start(config, {
        sessionId: "s-mutates",
        autoCleanup: true,
      });
      assert.equal(completed.conclusion?.outcome, "candidate_confirmed");
      assert.equal(completed.conclusion?.candidateSha, fixture.commitShas[1]!);

      // Now verify pre-aborted AbortSignal transitions cancel_requested -> cancelled
      const abortController = new AbortController();
      abortController.abort();
      const cancelled = await engine.start(config, {
        sessionId: "s-cancelled",
        abortSignal: abortController.signal,
      });
      assert.equal(cancelled.state, "cancelled");
      const events = readLedgerEvents(cancelled.ledgerPath);
      assert.ok(events.some((e) => e.type === "transition" && e.to === "cancel_requested"));
      assert.ok(events.some((e) => e.type === "transition" && e.to === "cancelled"));
      await engine.cleanup("s-cancelled", { dryRun: false }, sessionsRoot);
    } finally {
      fixture.cleanup();
    }
  });
});
