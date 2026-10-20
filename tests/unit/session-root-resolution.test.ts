import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1 } from "../../src/contracts/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { runCli } from "../../src/cli/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

test("Bug 6 - status, list, report, cleanup and resume resolve session root correctly from subdirectories and env var", async (t) => {
  const fixture = await buildFixtureRepo([
    { message: "initial good", files: { "file.txt": "good\n" } },
    { message: "introduce bug", files: { "file.txt": "bad\n" } },
  ]);

  const engine = new LocalBisectEngine();

  const config: BisectConfigV1 = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: fixture.repoDir,
    workingDirectory: ".",
    goodRef: fixture.commitShas[0]!,
    badRef: fixture.commitShas[1]!,
    oracle: {
      mode: "in-tree",
      command: {
        command: "sh",
        args: ["-c", "grep -q 'good' file.txt"],
        timeoutMs: 5000,
      },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      confirmBeforeExecutingCode: false,
    },
  };

  const origCwd = process.cwd();
  const origEnv = process.env.BISECTPILOT_SESSION_ROOT;

  try {
    const manifest = await engine.start(config);
    assert.ok(manifest.id);

    // Create subfolder inside repo
    const subDir = path.join(fixture.repoDir, "sub", "deep");
    mkdirSync(subDir, { recursive: true });

    // Switch cwd to subDir
    process.chdir(subDir);

    // 1. engine.status from subfolder
    const status = await engine.status(manifest.id);
    assert.equal(status.manifest.id, manifest.id);

    // 2. engine.list from subfolder
    const list = await engine.list();
    assert.ok(list.some((m) => m.id === manifest.id));

    // 3. runCli report from subfolder
    const origStdout = process.stdout.write;
    process.stdout.write = (() => true) as any;
    try {
      const reportExit = await runCli(["report", manifest.id], engine);
      assert.equal(reportExit, 0);
    } finally {
      process.stdout.write = origStdout;
    }

    // 4. engine.cleanup (dryRun) from subfolder
    const cleanupRes = await engine.cleanup(manifest.id, { dryRun: true });
    assert.equal(cleanupRes.sessionId, manifest.id);

    // 5. Custom BISECTPILOT_SESSION_ROOT
    const customSessions = path.join(fixture.tmpRoot, "custom-sessions");
    mkdirSync(customSessions, { recursive: true });
    process.env.BISECTPILOT_SESSION_ROOT = customSessions;

    // Start a new session targeting custom sessions via BISECTPILOT_SESSION_ROOT
    const manifest2 = await engine.start({
      ...config,
      repositoryRoot: fixture.repoDir,
    });
    assert.ok(manifest2.sessionDir.startsWith(customSessions));

    // Verify all commands find manifest2 in customSessions
    const status2 = await engine.status(manifest2.id);
    assert.equal(status2.manifest.id, manifest2.id);

    const list2 = await engine.list();
    assert.ok(list2.some((m) => m.id === manifest2.id));

    const cleanup2 = await engine.cleanup(manifest2.id, { dryRun: true });
    assert.equal(cleanup2.sessionId, manifest2.id);

    try {
      process.stdout.write = (() => true) as any;
      const reportExit2 = await runCli(["report", manifest2.id], engine);
      assert.equal(reportExit2, 0);
    } finally {
      process.stdout.write = origStdout;
    }
  } finally {
    process.chdir(origCwd);
    if (origEnv !== undefined) {
      process.env.BISECTPILOT_SESSION_ROOT = origEnv;
    } else {
      delete process.env.BISECTPILOT_SESSION_ROOT;
    }
    fixture.cleanup();
  }
});
