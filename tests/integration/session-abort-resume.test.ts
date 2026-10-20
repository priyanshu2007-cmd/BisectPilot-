import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectConfigV1 } from "../../src/contracts/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { readLedgerEvents } from "../../src/ledger/index.js";
import { buildFixtureRepo } from "../fixtures/repo-builder.js";

test("Bug 2 - session interrupted with AbortSignal or left in bisect_running can be resumed", async (t) => {
  const fixture = await buildFixtureRepo([
    { message: "commit 1 good", files: { "val.txt": "1\n" } },
    { message: "commit 2 good", files: { "val.txt": "2\n" } },
    { message: "commit 3 bad", files: { "val.txt": "3\n" } },
    { message: "commit 4 bad", files: { "val.txt": "4\n" } },
    { message: "commit 5 bad", files: { "val.txt": "5\n" } },
  ]);

  const engine = new LocalBisectEngine();

  // Oracle: Fast endpoints (1 & 5) for instant preflight, slow middle commits (sleep 1.5s) for bisection
  const slowScript = `
val=$(cat val.txt)
if [ "$val" -eq 1 ] || [ "$val" -eq 5 ]; then
  if [ "$val" -ge 3 ]; then exit 1; else exit 0; fi
fi
sleep 1.5
if [ "$val" -ge 3 ]; then exit 1; else exit 0; fi
`;

  const config: BisectConfigV1 = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: fixture.repoDir,
    workingDirectory: ".",
    goodRef: fixture.commitShas[0]!,
    badRef: fixture.commitShas[4]!,
    oracle: {
      mode: "in-tree",
      command: {
        command: "sh",
        args: ["-c", slowScript],
        timeoutMs: 10000,
      },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      confirmBeforeExecutingCode: false,
    },
  };

  try {
    // Variant A: AbortSignal triggered during bisect_running
    const abortController = new AbortController();
    let abortTriggered = false;

    const interruptedManifest = await engine.start(config, {
      sessionId: "sess-abort-01",
      abortSignal: abortController.signal,
      onEvent: (event) => {
        if (event.type === "transition" && (event as any).to === "bisect_running" && !abortTriggered) {
          abortTriggered = true;
          setTimeout(() => {
            abortController.abort();
          }, 200);
        }
      },
    });

    assert.ok(
      interruptedManifest.state === "paused" || interruptedManifest.state === "needs_recovery",
      `interrupted state should be paused or needs_recovery, got ${interruptedManifest.state}`
    );

    const events = readLedgerEvents(interruptedManifest.ledgerPath);
    const interruptTransition = events.find(
      (e) => e.type === "transition" && (e.to === "paused" || e.to === "needs_recovery")
    );
    assert.ok(interruptTransition, "ledger should record transition to paused or needs_recovery");
    assert.equal(
      (interruptTransition as any).reason,
      "interrupted by signal",
      "reason should be 'interrupted by signal'"
    );

    // Verify status reports resumable: true
    const status = await engine.status(interruptedManifest.id, path.dirname(interruptedManifest.sessionDir));
    assert.equal(status.checkpoint?.resumable, true, "status should report resumable: true");

    // Fast oracle config for resume
    const fastConfig: BisectConfigV1 = {
      ...config,
      oracle: {
        mode: "in-tree",
        command: {
          command: "sh",
          args: ["-c", 'val=$(cat val.txt); if [ "$val" -ge 3 ]; then exit 1; else exit 0; fi'],
          timeoutMs: 5000,
        },
      },
    };

    // Now resume and verify completion
    const resumed = await engine.resume(interruptedManifest.id, {}, path.dirname(interruptedManifest.sessionDir));
    assert.equal(resumed.state, "concluded");
    assert.equal(resumed.conclusion?.outcome, "candidate_confirmed");
    assert.equal(resumed.conclusion?.candidateSha, fixture.commitShas[2]!);

    // Variant B: Session directly in bisect_running with no live lock (reproduces the exact bug 2 crash)
    const normal = await engine.start(fastConfig, { sessionId: "sess-kill-01" });
    assert.equal(normal.state, "concluded");

    // Artificially reset manifest to state: "bisect_running" with no lock (as if killed abruptly)
    const manifestPath = path.join(normal.sessionDir, "manifest.json");
    const manifestContent = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifestContent.state = "bisect_running";
    delete manifestContent.conclusion;
    writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2) + "\n", "utf-8");

    // This must NOT throw "Illegal session state transition: bisect_running -> bisect_running"
    const resumedKilled = await engine.resume("sess-kill-01", {}, path.dirname(normal.sessionDir));
    assert.equal(resumedKilled.conclusion?.outcome, "candidate_confirmed");
    assert.equal(resumedKilled.conclusion?.candidateSha, fixture.commitShas[2]!);
  } finally {
    fixture.cleanup();
  }
});
