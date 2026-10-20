import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1 } from "../../src/contracts/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { acquireSessionLock, releaseSessionLock } from "../../src/session/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

test("Bug 8 - cleanup refuses to remove worktree of a session that is actively running", async (t) => {
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

  try {
    const manifest = await engine.start(config);
    const worktreePath = manifest.repository.worktreePath;
    assert.ok(existsSync(worktreePath), "Worktree should exist after session completes");

    // Simulate active session by acquiring live lock
    acquireSessionLock(manifest.sessionDir);

    const sessionRoot = path.dirname(manifest.sessionDir);

    // cleanup must be refused
    await assert.rejects(
      async () => {
        await engine.cleanup(manifest.id, undefined, sessionRoot);
      },
      (err: any) => {
        return (
          err instanceof Error &&
          err.message.includes(`Session ${manifest.id} is running (PID ${process.pid}); stop it first`)
        );
      },
      "cleanup should throw when session lock is live"
    );

    // Worktree must still exist
    assert.ok(existsSync(worktreePath), "Worktree must not be deleted when cleanup is refused");

    // Release lock and cleanup should now succeed
    releaseSessionLock(manifest.sessionDir);
    const cleanupRes = await engine.cleanup(manifest.id, undefined, sessionRoot);
    assert.equal(cleanupRes.removedWorktree, true);
    assert.ok(!existsSync(worktreePath), "Worktree should be deleted after successful cleanup");
  } finally {
    fixture.cleanup();
  }
});
