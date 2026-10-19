import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_STATE_TRANSITIONS,
  DETERMINISTIC_ENV_DEFAULTS,
  FakeEngine,
  GIT_BISECT_EXIT_CODES,
  isValidStateTransition,
  mapClassificationToGitExitCode,
  validateConfig,
} from "../../src/contracts/index.js";

describe("Phase G0 — Frozen Contracts", () => {
  it("validates a well-formed BisectConfigV1 and rejects invalid configs", () => {
    const valid = validateConfig({
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/tmp/repo",
      workingDirectory: ".",
      goodRef: "v1.0.0",
      badRef: "HEAD",
      oracle: {
        mode: "overlay",
        command: { command: "node", args: ["test-reg.mjs"], timeoutMs: 10000 },
        overlayFiles: ["test-reg.mjs"],
      },
      execution: {
        maxOutputBytesPerCommand: 500_000,
        maxRetries: 0,
        endpointFlakeRuns: 3,
        boundaryConfirmRuns: 3,
        maxSkips: 5,
        confirmBeforeExecutingCode: true,
        cleanIgnored: false,
        allowlistedEnvVars: ["CUSTOM_FLAG"],
      },
    });
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.value.oracle.mode, "overlay");
      assert.equal(valid.value.oracle.overlayConflictPolicy, "skip");
    }

    const invalid = validateConfig({
      schemaVersion: 2,
      profile: "unknown",
      oracle: { mode: "overlay", command: { command: "", args: [] } },
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.ok(invalid.issues.length >= 4);
    }
  });

  it("maps classifications to native Git Bisect exit codes and never emits 126 or 127", () => {
    assert.equal(mapClassificationToGitExitCode("good"), 0);
    assert.equal(mapClassificationToGitExitCode("bad"), 1);
    assert.equal(mapClassificationToGitExitCode("skip"), 125);
    assert.equal(mapClassificationToGitExitCode("abort"), 128);
    for (const code of Object.values(GIT_BISECT_EXIT_CODES)) {
      assert.notEqual(code, 126);
      assert.notEqual(code, 127);
    }
  });

  it("enforces the unified Section 27 state transition table", () => {
    assert.equal(isValidStateTransition("created", "preflight_running"), true);
    assert.equal(isValidStateTransition("bisect_running", "paused"), true);
    assert.equal(isValidStateTransition("paused", "bisect_running"), true);
    assert.equal(isValidStateTransition("cleaned_up", "bisect_running"), false);
    assert.equal(ALLOWED_STATE_TRANSITIONS.cleaned_up.length, 0);
    assert.equal(DETERMINISTIC_ENV_DEFAULTS.CI, "1");
  });

  it("executes FakeEngine lifecycle methods deterministically", async () => {
    const fake = new FakeEngine();
    const doc = await fake.doctor("/tmp/repo");
    assert.equal(doc.ok, true);

    const cfgRes = validateConfig({
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/tmp/repo",
      workingDirectory: ".",
      goodRef: "HEAD~5",
      badRef: "HEAD",
      oracle: {
        mode: "in-tree",
        command: { command: "npm", args: ["test"], timeoutMs: 30000 },
      },
    });
    assert.equal(cfgRes.ok, true);
    if (!cfgRes.ok) return;

    const events: string[] = [];
    const manifest = await fake.start(cfgRes.value, {
      sessionId: "s-01",
      onEvent: (e) => events.push(e.type),
      confirm: () => true,
    });
    assert.equal(manifest.state, "concluded");
    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
    assert.deepEqual(events, ["session_created"]);

    const status = await fake.status("s-01");
    assert.equal(status.ledgerValid, true);

    const cleanupDry = await fake.cleanup("s-01", { dryRun: true });
    assert.equal(cleanupDry.removedWorktree, false);

    const cleanupReal = await fake.cleanup("s-01", { dryRun: false });
    assert.equal(cleanupReal.state, "cleaned_up");
  });
});
