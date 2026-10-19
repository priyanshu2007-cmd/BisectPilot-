import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calculateBayesianPosterior,
  evaluateBayesianDecision,
} from "../../src/domain/bayesian.js";
import {
  DEFAULT_EXECUTION_POLICY,
  type BisectConfigV1,
} from "../../src/contracts/config.js";
import { evaluateCheckedOutRevision } from "../../src/oracle/index.js";
import { readLedgerEvents } from "../../src/ledger/index.js";
import { LocalBisectEngine } from "../../src/application/index.js";
import { execSync } from "node:child_process";

test("Feature B — Bayesian Posterior & Decision Math", async (t) => {
  await t.test("prior state when 0 passes and 0 fails is 0.5", () => {
    const p = calculateBayesianPosterior(0, 0, 0.1);
    assert.equal(p, 0.5);
  });

  await t.test("symmetric passes and fails result in 0.5 posterior", () => {
    assert.equal(calculateBayesianPosterior(2, 2, 0.1), 0.5);
    assert.equal(calculateBayesianPosterior(5, 5, 0.05), 0.5);
  });

  await t.test("repeated bad (failed) samples drive posterior towards 1.0", () => {
    const p1 = calculateBayesianPosterior(0, 1, 0.1); // fails=1, passes=0 -> r^(passes-fails) = 9^-1 = 1/9 -> 9/10 = 0.90
    assert.ok(Math.abs(p1 - 0.90) < 1e-4);

    const p2 = calculateBayesianPosterior(0, 2, 0.1); // 9^-2 = 1/81 -> 81/82 ≈ 0.9878
    assert.ok(p2 > 0.98);

    const decision = evaluateBayesianDecision({ passes: 0, fails: 2, flakeRate: 0.1, confidenceThreshold: 0.9 });
    assert.equal(decision.decision, "bad");
    assert.ok(decision.posteriorBad > 0.9);
  });

  await t.test("repeated good (passed) samples drive posterior towards 0.0", () => {
    const p1 = calculateBayesianPosterior(1, 0, 0.1); // 1/(1+9^1) = 1/10 = 0.10
    assert.ok(Math.abs(p1 - 0.10) < 1e-4);

    const decision = evaluateBayesianDecision({ passes: 2, fails: 0, flakeRate: 0.1, confidenceThreshold: 0.9 });
    assert.equal(decision.decision, "good");
    assert.ok(decision.posteriorGood > 0.9);
  });

  await t.test("contradictory samples remain undecided when threshold not reached", () => {
    // 2 fails and 1 pass: passes - fails = -1 -> P(bad) = 0.90
    // If threshold is 0.95, it's undecided
    const decision = evaluateBayesianDecision({ passes: 1, fails: 2, flakeRate: 0.1, confidenceThreshold: 0.95 });
    assert.equal(decision.decision, "inconclusive");
  });
});

test("Feature B — Noisy Oracle Multi-Sampling Engine Integration", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-noisy-oracle-test-"));
  const ledgerPath = path.join(tmpDir, "ledger.jsonl");

  const baseConfig: BisectConfigV1 = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: tmpDir,
    workingDirectory: ".",
    goodRef: "HEAD~1",
    badRef: "HEAD",
    oracle: {
      mode: "in-tree",
      command: { command: "node", args: [], timeoutMs: 30_000 },
    },
    execution: {
      ...DEFAULT_EXECUTION_POLICY,
      noisyOracle: {
        enabled: true,
        maxSamplesPerRevision: 5,
        confidenceThreshold: 0.90,
        flakeRate: 0.10,
      },
      confirmBeforeExecutingCode: false,
    },
  };

  await t.test("repeated all-bad samples reach confidence and classify as bad early", async () => {
    // Script always exits 1 (fails)
    const script = path.join(tmpDir, "fail.js");
    writeFileSync(script, "process.exit(1);", "utf-8");

    const config: BisectConfigV1 = {
      ...baseConfig,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: [script], timeoutMs: 30_000 },
      },
    };

    const outcome = await evaluateCheckedOutRevision({
      sessionId: "test-noisy-1",
      sessionDir: tmpDir,
      ledgerPath,
      worktreePath: tmpDir,
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      overlayHashes: {},
      config,
    });

    assert.equal(outcome.kind, "bad");
    assert.equal(outcome.reasonCode, "oracle_failed_expected_regression");
    assert.ok(outcome.noisySampling);
    assert.ok(outcome.noisySampling!.failedRuns >= 1);
    assert.ok(outcome.noisySampling!.posterior >= 0.90);
  });

  await t.test("repeated all-good samples reach confidence and classify as good early", async () => {
    const script = path.join(tmpDir, "pass.js");
    writeFileSync(script, "process.exit(0);", "utf-8");

    const config: BisectConfigV1 = {
      ...baseConfig,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: [script], timeoutMs: 30_000 },
      },
    };

    const outcome = await evaluateCheckedOutRevision({
      sessionId: "test-noisy-2",
      sessionDir: tmpDir,
      ledgerPath,
      worktreePath: tmpDir,
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      overlayHashes: {},
      config,
    });

    assert.equal(outcome.kind, "good");
    assert.equal(outcome.reasonCode, "oracle_passed");
    assert.ok(outcome.noisySampling);
    assert.equal(outcome.noisySampling?.passedRuns, 1);
  });

  await t.test("contradictory samples exhaust budget when threshold is high, classifying as skip", async () => {
    // Alternating pass and fail script using a counter file
    const counterFile = path.join(tmpDir, "counter.txt");
    writeFileSync(counterFile, "0", "utf-8");
    const script = path.join(tmpDir, "flipflop.js");
    writeFileSync(
      script,
      `
      const fs = require('fs');
      const count = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf-8'), 10);
      fs.writeFileSync(${JSON.stringify(counterFile)}, String(count + 1), 'utf-8');
      process.exit(count % 2 === 0 ? 0 : 1);
    `,
      "utf-8"
    );

    const config: BisectConfigV1 = {
      ...baseConfig,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: [script], timeoutMs: 30_000 },
      },
      execution: {
        ...baseConfig.execution,
        noisyOracle: {
          enabled: true,
          maxSamplesPerRevision: 4,
          confidenceThreshold: 0.95,
          flakeRate: 0.10,
        },
      },
    };

    const outcome = await evaluateCheckedOutRevision({
      sessionId: "test-noisy-3",
      sessionDir: tmpDir,
      ledgerPath,
      worktreePath: tmpDir,
      commitSha: "cccccccccccccccccccccccccccccccccccccccc",
      overlayHashes: {},
      config,
    });

    assert.equal(outcome.kind, "skip");
    assert.equal(outcome.reasonCode, "skip_budget_exceeded");
    assert.ok(outcome.noisySampling);
    assert.equal(outcome.noisySampling?.sampleCount, 4);
    assert.equal(outcome.noisySampling?.passedRuns, 2);
    assert.equal(outcome.noisySampling?.failedRuns, 2);
  });

  await t.test("cancellation halts multi-sampling immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const script = path.join(tmpDir, "pass.js");
    const config: BisectConfigV1 = {
      ...baseConfig,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: [script], timeoutMs: 30_000 },
      },
    };

    const outcome = await evaluateCheckedOutRevision({
      sessionId: "test-noisy-abort",
      sessionDir: tmpDir,
      ledgerPath,
      worktreePath: tmpDir,
      commitSha: "dddddddddddddddddddddddddddddddddddddddd",
      overlayHashes: {},
      config,
      abortSignal: controller.signal,
    });

    assert.equal(outcome.kind, "abort");
    assert.equal(outcome.reasonCode, "cancelled");
  });

  await t.test("deterministic mode retains single sample execution when noisyOracle is not enabled", async () => {
    const script = path.join(tmpDir, "pass.js");
    const config: BisectConfigV1 = {
      ...baseConfig,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: [script], timeoutMs: 30_000 },
      },
      execution: {
        ...DEFAULT_EXECUTION_POLICY,
        confirmBeforeExecutingCode: false,
      },
    };

    const outcome = await evaluateCheckedOutRevision({
      sessionId: "test-deterministic",
      sessionDir: tmpDir,
      ledgerPath,
      worktreePath: tmpDir,
      commitSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      overlayHashes: {},
      config,
    });

    assert.equal(outcome.kind, "good");
    assert.equal(outcome.noisySampling, undefined);
  });

  await t.test("ledger contains revision_classified with noisySampling provenance", () => {
    const events = readLedgerEvents(ledgerPath);
    const noisyEvents = events.filter(
      (e): e is Extract<typeof e, { type: "revision_classified" }> =>
        e.type === "revision_classified" && (e as any).noisySampling !== undefined
    );
    assert.ok(noisyEvents.length >= 3);
    const first = noisyEvents[0];
    assert.ok(first && first.noisySampling);
    assert.ok(first.noisySampling.sampleCount >= 1);
  });

  rmSync(tmpDir, { recursive: true, force: true });
});

test("Feature B — Endpoint Preflight Under Noisy-Oracle Mode", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-noisy-endpoints-"));
  try {
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });

    writeFileSync(path.join(tmpDir, "f.txt"), "0", "utf-8");
    execSync("git add f.txt && git commit -m 'c1: good'", { cwd: tmpDir, stdio: "ignore" });
    const c1Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    writeFileSync(path.join(tmpDir, "f.txt"), "1", "utf-8");
    execSync("git add f.txt && git commit -m 'c2: bad'", { cwd: tmpDir, stdio: "ignore" });
    const c2Sha = execSync("git rev-parse HEAD", { cwd: tmpDir }).toString().trim().toLowerCase();

    // In a flaky test where good fails occasionally or bad passes occasionally:
    // With 10% flakeRate allowed:
    const config: BisectConfigV1 = {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: c1Sha,
      badRef: c2Sha,
      oracle: {
        mode: "in-tree",
        command: {
          command: "node",
          args: ["-e", 'const fs = require("fs"); process.exit(fs.readFileSync("f.txt", "utf-8") === "1" ? 1 : 0);'],
          timeoutMs: 30_000,
        },
      },
      execution: {
        ...DEFAULT_EXECUTION_POLICY,
        endpointFlakeRuns: 3,
        boundaryConfirmRuns: 2,
        confirmBeforeExecutingCode: false,
        noisyOracle: {
          enabled: true,
          flakeRate: 0.10,
          confidenceThreshold: 0.90,
          maxSamplesPerRevision: 5,
        },
      },
    };

    const engine = new LocalBisectEngine();
    const manifest = await engine.start(config);

    assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
    assert.equal(manifest.conclusion?.candidateSha, c2Sha);
    assert.equal(manifest.conclusion?.parentSha, c1Sha);

    await engine.cleanup(manifest.id, { dryRun: false }, path.dirname(manifest.sessionDir));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
