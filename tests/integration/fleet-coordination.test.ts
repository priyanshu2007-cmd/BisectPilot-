import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DaemonService } from "../../src/daemon/index.js";
import { DaemonClient, daemonBaseUrl } from "../../src/daemon/client.js";
import { WorkerService } from "../../src/worker/index.js";
import { FakeEngine } from "../../src/contracts/fake-engine.js";
import { FleetCoordinator } from "../../src/jobs/fleet-coordinator.js";
import { DEFAULT_EXECUTION_POLICY, type BisectJobPayload } from "../../src/contracts/index.js";

function makePayload(repoKey = "default"): BisectJobPayload {
  return {
    config: {
      schemaVersion: 1,
      profile: "functional",
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: ["test.js"], timeoutMs: 1_000 },
      },
      workingDirectory: ".",
      goodRef: "1111111111111111111111111111111111111111",
      badRef: "9999999999999999999999999999999999999999",
      repositoryRoot: "/tmp/repo",
      sessionRootDir: "/tmp/sessions",
      execution: { ...DEFAULT_EXECUTION_POLICY, confirmBeforeExecutingCode: false },
    },
    repository: {
      strategy: "preprovisioned",
      key: repoKey,
      expectedGoodSha: "1111111111111111111111111111111111111111",
      expectedBadSha: "9999999999999999999999999999999999999999",
    },
  };
}

describe("Distributed Bisection Fleet & Multi-Worker Coordination Integration", () => {
  it("coordinates multi-worker parallel noisy-oracle sampling over live daemon", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-integration-"));
    const daemon = new DaemonService({
      stateDir: path.join(root, "daemon"),
      port: 0,
      leaseMs: 10_000,
    });
    let worker1: WorkerService | undefined;
    let worker2: WorkerService | undefined;

    try {
      const daemonState = await daemon.start();
      const serverUrl = daemonBaseUrl(daemonState);

      // Worker 1: handles sample evaluations, reports "bad"
      worker1 = new WorkerService({
        stateDir: path.join(root, "worker1"),
        serverUrl,
        daemonTokenFile: daemonState.tokenFile,
        repositories: { default: process.cwd() },
        workerId: "fleet-worker-1",
        pollMs: 250,
        jobTypes: ["sample_evaluation"],
        maxConcurrentJobs: 2,
        sampleEvaluator: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { outcome: "bad", durationMs: 10 };
        },
        engine: new FakeEngine(),
      });
      await worker1.start();

      // Worker 2: handles sample evaluations, reports "bad"
      worker2 = new WorkerService({
        stateDir: path.join(root, "worker2"),
        serverUrl,
        daemonTokenFile: daemonState.tokenFile,
        repositories: { default: process.cwd() },
        workerId: "fleet-worker-2",
        pollMs: 250,
        jobTypes: ["sample_evaluation"],
        maxConcurrentJobs: 2,
        sampleEvaluator: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { outcome: "bad", durationMs: 10 };
        },
        engine: new FakeEngine(),
      });
      await worker2.start();

      const client = new DaemonClient({
        baseUrl: serverUrl,
        tokenFile: daemonState.tokenFile,
      });

      // Check daemon status shows 2 registered workers with total capacity 4
      const status = await client.status();
      assert.equal(status.workers.length, 2);

      // Schedule noisy oracle batch using daemon's queue store
      const revSha = "abcdef1234567890abcdef1234567890abcdef12";
      const decision = await FleetCoordinator.scheduleNoisyOracleBatch({
        store: daemon.queue,
        parentJobId: "fleet-parent-1",
        revisionSha: revSha,
        basePayload: makePayload(),
        maxSamples: 4,
        minSamples: 2,
        confidenceThreshold: 0.85,
        flakeRate: 0.1,
        pollIntervalMs: 50,
        timeoutMs: 10_000,
      });

      // Both workers pull and evaluate samples in parallel, reaching "bad" decision
      assert.equal(decision.decision, "bad");
      assert.ok(decision.fails >= 2);
      assert.equal(decision.earlyStopped, true);
    } finally {
      if (worker1) await worker1.stop().catch(() => undefined);
      if (worker2) await worker2.stop().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces lease fencing and rejects late results over client/server protocol", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-fence-protocol-"));
    const daemon = new DaemonService({
      stateDir: path.join(root, "daemon"),
      port: 0,
      leaseMs: 5_000,
    });

    try {
      const daemonState = await daemon.start();
      const serverUrl = daemonBaseUrl(daemonState);
      const client = new DaemonClient({
        baseUrl: serverUrl,
        tokenFile: daemonState.tokenFile,
      });

      // Register worker
      await client.registerWorker({
        workerId: "test-fenced-worker",
        protocolVersion: 1,
        jobTypes: ["bisect"],
        repositoryKeys: ["default"],
        platform: process.platform,
        architecture: process.arch,
        maxConcurrentJobs: 1,
      });

      // Create a job in daemon queue
      const job = daemon.queue.create(makePayload());

      // Worker polls and claims job
      const pollRes = await client.poll({
        workerId: "test-fenced-worker",
        protocolVersion: 1,
        jobTypes: ["bisect"],
        repositoryKeys: ["default"],
        platform: process.platform,
        architecture: process.arch,
        maxConcurrentJobs: 1,
      });
      assert.ok(pollRes.job);
      assert.equal(pollRes.job.fencingToken, 2);

      // Attempt submission with stale fencing token (1 instead of 2) -> rejected
      await assert.rejects(
        () => client.result(job.id, "test-fenced-worker", 1, {
          status: "succeeded",
          sessionId: job.sessionId,
          fencingToken: 1,
        }),
        /Job fencing token mismatch/
      );

      // Advance lease expiration
      daemon.queue.recoverExpiredLeases(new Date(Date.now() + 100_000));

      // Result after lease expiration must be rejected
      await assert.rejects(
        () => client.result(job.id, "test-fenced-worker", 1, {
          status: "succeeded",
          sessionId: job.sessionId,
          fencingToken: 2,
        }),
        /attempt is no longer current|expired|mismatch|state/i
      );
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
