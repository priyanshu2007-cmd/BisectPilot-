import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AtomicJobStore,
  isWorkerEligible,
  FleetCoordinator,
  type CreateJobOptions,
} from "../../src/jobs/index.js";
import {
  DEFAULT_EXECUTION_POLICY,
  type BisectJobPayload,
  type WorkerCapabilities,
} from "../../src/contracts/index.js";
import { defaultMetrics } from "../../src/telemetry/index.js";

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

const baseWorker: WorkerCapabilities = {
  workerId: "worker-1",
  protocolVersion: 1,
  jobTypes: ["bisect", "sample_evaluation", "benchmark_sample"],
  repositoryKeys: ["default"],
  platform: process.platform,
  architecture: process.arch,
  maxConcurrentJobs: 2,
  sandboxRuntimes: ["docker"],
  supportedProfiles: ["functional", "performance"],
  features: ["noisy", "benchmark", "workspace"],
  environmentIdentity: {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
  },
};

describe("Feature A — Worker Capability Matching & Bounded Scheduling", () => {
  it("matches eligible worker across job types, repository keys, sandboxes, and environment identity", () => {
    assert.equal(
      isWorkerEligible(
        baseWorker,
        {
          jobTypes: ["sample_evaluation"],
          repositoryKey: "default",
          sandboxRuntime: "docker",
          profile: "functional",
          features: ["noisy"],
          environmentIdentity: {
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.version,
          },
        },
        "sample_evaluation"
      ),
      true
    );
  });

  it("rejects worker with mismatched job type or repository key", () => {
    assert.equal(
      isWorkerEligible(baseWorker, { jobTypes: ["bisect"], repositoryKey: "other_repo" }, "bisect"),
      false
    );
    assert.equal(
      isWorkerEligible({ ...baseWorker, jobTypes: ["bisect"] }, { jobTypes: ["sample_evaluation"], repositoryKey: "default" }, "sample_evaluation"),
      false
    );
  });

  it("rejects worker with incompatible environment identity for benchmarks", () => {
    assert.equal(
      isWorkerEligible(
        baseWorker,
        {
          jobTypes: ["benchmark_sample"],
          repositoryKey: "default",
          environmentIdentity: {
            platform: "linux",
            architecture: "s390x", // Incompatible arch
          },
        },
        "benchmark_sample"
      ),
      false
    );

    assert.equal(
      isWorkerEligible(
        baseWorker,
        {
          jobTypes: ["benchmark_sample"],
          repositoryKey: "default",
          environmentIdentity: {
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: "v99.0.0", // Incompatible node version
          },
        },
        "benchmark_sample"
      ),
      false
    );
  });

  it("enforces worker maxConcurrentJobs limit on claimNext", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-concurrency-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const workerCaps: WorkerCapabilities = { ...baseWorker, maxConcurrentJobs: 2 };

      store.create(makePayload());
      store.create(makePayload());
      store.create(makePayload());

      // Worker claims 1st job
      const j1 = store.claimNext(workerCaps);
      assert.ok(j1);

      // Worker claims 2nd job (reached maxConcurrentJobs: 2)
      const j2 = store.claimNext(workerCaps);
      assert.ok(j2);

      // 3rd claim must be rejected due to concurrency limit
      const j3 = store.claimNext(workerCaps);
      assert.equal(j3, undefined);

      // Releasing 1st job allows claiming 3rd
      store.submitResult(j1.id, workerCaps.workerId, j1.attempt, {
        status: "succeeded",
        sessionId: j1.sessionId,
      });

      const j3Retry = store.claimNext(workerCaps);
      assert.ok(j3Retry);
      assert.equal(j3Retry.id !== j1.id && j3Retry.id !== j2.id, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Feature B — Lease Fencing & Stale-Result Rejection", () => {
  it("increments fencing token on every claim attempt and verifies versioned ownership", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-fencing-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const job = store.create(makePayload());
      assert.equal(job.fencingToken, 1);

      // Claim 1
      const claimed1 = store.claimNext(baseWorker);
      assert.ok(claimed1);
      assert.equal(claimed1.attempt, 1);
      assert.equal(claimed1.fencingToken, 2);

      // Expire lease
      store.recoverExpiredLeases(new Date(Date.now() + 100_000));

      // Claim 2
      const claimed2 = store.claimNext(baseWorker);
      assert.ok(claimed2);
      assert.equal(claimed2.attempt, 2);
      assert.equal(claimed2.fencingToken, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects heartbeat and result submissions with stale fencing tokens", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-stale-fence-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const job = store.create(makePayload());
      const claimed = store.claimNext(baseWorker);
      assert.ok(claimed);
      assert.equal(claimed.fencingToken, 2);

      // Heartbeat with stale token throws
      assert.throws(
        () => store.heartbeat(job.id, baseWorker.workerId, claimed.attempt, 30_000, new Date(), 1),
        /fencing token mismatch/i
      );

      // Heartbeat with valid token succeeds
      const hb = store.heartbeat(job.id, baseWorker.workerId, claimed.attempt, 30_000, new Date(), 2);
      assert.equal(hb.cancelRequested, false);

      // Submit result with stale token throws
      assert.throws(
        () => store.submitResult(job.id, baseWorker.workerId, claimed.attempt, { status: "succeeded", sessionId: job.sessionId }, new Date(), 1),
        /fencing token mismatch/i
      );

      // Submit result with valid token succeeds
      const res = store.submitResult(job.id, baseWorker.workerId, claimed.attempt, { status: "succeeded", sessionId: job.sessionId }, new Date(), 2);
      assert.equal(res.accepted, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles duplicate result submissions idempotently without double-advancing state", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-idempotent-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const job = store.create(makePayload());
      const claimed = store.claimNext(baseWorker);
      assert.ok(claimed);

      const first = store.submitResult(job.id, baseWorker.workerId, claimed.attempt, {
        status: "succeeded",
        sessionId: job.sessionId,
      });
      assert.equal(first.accepted, true);
      assert.equal(first.duplicate, false);

      // Duplicate submission
      const second = store.submitResult(job.id, baseWorker.workerId, claimed.attempt, {
        status: "succeeded",
        sessionId: job.sessionId,
      });
      assert.equal(second.accepted, false);
      assert.equal(second.duplicate, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Feature C — Parallel Noisy-Oracle Sampling & Early Stopping", () => {
  it("fans out independent sample jobs and stops early once Bayesian threshold is reached", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-noisy-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const revSha = "abcdef1234567890abcdef1234567890abcdef12";

      // Start batch scheduling in background
      const batchPromise = FleetCoordinator.scheduleNoisyOracleBatch({
        store,
        parentJobId: "parent-1",
        revisionSha: revSha,
        basePayload: makePayload(),
        maxSamples: 5,
        minSamples: 2,
        confidenceThreshold: 0.85,
        flakeRate: 0.1,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });

      // Simulate workers claiming and reporting 3 "bad" samples
      // Under Bayesian model, 3 fails in a row yields P(bad) > 0.99, triggering early stop before 5 samples
      for (let s = 1; s <= 3; s++) {
        await new Promise((r) => setTimeout(r, 20));
        const sampleJob = store.claimNext({ ...baseWorker, jobTypes: ["sample_evaluation"], maxConcurrentJobs: 10 });
        if (sampleJob) {
          store.submitResult(sampleJob.id, baseWorker.workerId, sampleJob.attempt, {
            status: "succeeded",
            sessionId: sampleJob.sessionId,
            sampleResult: { outcome: "bad", durationMs: 10 },
          });
        }
      }

      const decision = await batchPromise;
      assert.equal(decision.decision, "bad");
      assert.equal(decision.fails >= 2, true);
      assert.equal(decision.earlyStopped, true);
      assert.equal(decision.sampleJobIds.length, 5);

      // Verify that unneeded remaining sample jobs were cancelled
      const allJobs = store.list();
      const cancelledCount = allJobs.filter((j) => j.state === "cancelled").length;
      assert.ok(cancelledCount >= 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns inconclusive when sampling budget is exhausted without reaching confidence threshold", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-noisy-inconclusive-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const revSha = "abcdef1234567890abcdef1234567890abcdef12";

      const batchPromise = FleetCoordinator.scheduleNoisyOracleBatch({
        store,
        parentJobId: "parent-2",
        revisionSha: revSha,
        basePayload: makePayload(),
        maxSamples: 3,
        minSamples: 2,
        confidenceThreshold: 0.95,
        flakeRate: 0.1,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });

      // Report alternating good and bad (1 pass, 1 fail, 1 pass -> diff = 1, posterior ~0.50, inconclusive)
      const outcomes: ("good" | "bad")[] = ["good", "bad", "good"];
      for (const outcome of outcomes) {
        await new Promise((r) => setTimeout(r, 20));
        const sampleJob = store.claimNext({ ...baseWorker, jobTypes: ["sample_evaluation"], maxConcurrentJobs: 10 });
        if (sampleJob) {
          store.submitResult(sampleJob.id, baseWorker.workerId, sampleJob.attempt, {
            status: "succeeded",
            sessionId: sampleJob.sessionId,
            sampleResult: { outcome, durationMs: 10 },
          });
        }
      }

      const decision = await batchPromise;
      assert.equal(decision.decision, "inconclusive");
      assert.equal(decision.earlyStopped, false);
      assert.equal(decision.totalEvaluated, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Feature D — Parallel Benchmark Sampling", () => {
  it("schedules benchmark samples, checks environment identity, and evaluates regression", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-bench-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const baselineSha = "1111111111111111111111111111111111111111";
      const candidateSha = "2222222222222222222222222222222222222222";

      const batchPromise = FleetCoordinator.scheduleBenchmarkBatch({
        store,
        parentJobId: "parent-bench",
        baselineSha,
        candidateSha,
        basePayload: makePayload(),
        benchmarkSpec: {
          metric: "duration_ms",
          direction: "higher_is_worse",
          threshold: 150,
          minSamples: 3,
          maxSamples: 3,
          alpha: 0.05,
        },
        environmentIdentity: baseWorker.environmentIdentity!,
        minSamples: 3,
        maxSamples: 3,
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });

      // Baseline: 100, 102, 101 ms
      // Candidate: 200, 205, 202 ms (significant regression)
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        const job = store.claimNext({ ...baseWorker, jobTypes: ["benchmark_sample"], maxConcurrentJobs: 10 });
        if (job) {
          const isCandidate = job.sampleMetadata?.revisionSha === candidateSha;
          const measurement = isCandidate ? 200 + i : 100 + i;
          store.submitResult(job.id, baseWorker.workerId, job.attempt, {
            status: "succeeded",
            sessionId: job.sessionId,
            sampleResult: { outcome: "good", measurement, durationMs: 50 },
          });
        }
      }

      const decision = await batchPromise;
      assert.equal(decision.decision, "regression");
      assert.equal(decision.candidateMeasurements.length, 3);
      assert.equal(decision.baselineMeasurements.length, 3);
      assert.ok(decision.evaluation);
      assert.equal(decision.evaluation?.isSignificant, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Feature G — Fleet Capacity Reporting", () => {
  it("accurately computes eligible workers, capacity, and utilized concurrency", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-fleet-capacity-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const workers = [
        { capabilities: { ...baseWorker, workerId: "w1", maxConcurrentJobs: 3 }, lastSeenAt: new Date().toISOString() },
        { capabilities: { ...baseWorker, workerId: "w2", maxConcurrentJobs: 2 }, lastSeenAt: new Date().toISOString() },
        { capabilities: { ...baseWorker, workerId: "w3", repositoryKeys: ["other"] }, lastSeenAt: new Date().toISOString() },
      ];

      const report = FleetCoordinator.getFleetCapacity(store, workers, "sample_evaluation", {
        jobTypes: ["sample_evaluation"],
        repositoryKey: "default",
      });

      assert.equal(report.totalWorkers, 3);
      assert.equal(report.eligibleWorkers, 2); // w1 and w2 match default repo
      assert.equal(report.totalConcurrencyCapacity, 3 + 2 + 2); // 7
      assert.equal(report.activeConcurrencyUtilized, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
