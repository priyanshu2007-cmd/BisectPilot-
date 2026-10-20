import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectJobPayload, type WorkerCapabilities } from "../../src/contracts/index.js";
import { AtomicJobStore } from "../../src/jobs/index.js";

const GOOD_SHA = "1111111111111111111111111111111111111111";
const BAD_SHA = "9999999999999999999999999999999999999999";

function payload(): BisectJobPayload {
  return {
    config: {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/tmp/preprovisioned-repo",
      workingDirectory: ".",
      goodRef: GOOD_SHA,
      badRef: BAD_SHA,
      oracle: {
        mode: "in-tree",
        command: { command: "node", args: ["check.mjs"], timeoutMs: 1_000 },
      },
      execution: { ...DEFAULT_EXECUTION_POLICY, confirmBeforeExecutingCode: false },
    },
    repository: {
      strategy: "preprovisioned",
      key: "default",
      expectedGoodSha: GOOD_SHA,
      expectedBadSha: BAD_SHA,
    },
  };
}

const worker: WorkerCapabilities = {
  workerId: "worker-test",
  protocolVersion: 1,
  jobTypes: ["bisect"],
  repositoryKeys: ["default"],
  platform: "test",
  architecture: "test",
  maxConcurrentJobs: 1,
};

describe("durable asynchronous jobs", () => {
  it("persists a lease, starts on heartbeat, and accepts duplicate results idempotently", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-jobs-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      const created = store.create(payload(), createdAt);
      const leased = store.claimNext(worker, 10_000, createdAt);
      assert.equal(leased?.id, created.id);
      assert.equal(leased?.state, "leased");
      assert.equal(leased?.attempt, 1);

      const heartbeat = store.heartbeat(created.id, worker.workerId, 1, 10_000, new Date(createdAt.getTime() + 100));
      assert.equal(heartbeat.job.state, "running");
      assert.equal(heartbeat.cancelRequested, false);

      const result = store.submitResult(
        created.id,
        worker.workerId,
        1,
        { status: "succeeded", sessionId: created.sessionId, detail: "done" },
        new Date(createdAt.getTime() + 200)
      );
      assert.equal(result.accepted, true);
      assert.equal(result.job.state, "succeeded");

      const duplicate = store.submitResult(
        created.id,
        worker.workerId,
        1,
        { status: "succeeded", sessionId: created.sessionId, detail: "duplicate" },
        new Date(createdAt.getTime() + 300)
      );
      assert.equal(duplicate.accepted, false);
      assert.equal(duplicate.duplicate, true);
      assert.equal(store.summary().succeeded, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requeues an unstarted expired lease and blocks started work for explicit recovery", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-jobs-recovery-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      const first = store.create(payload(), createdAt);
      store.claimNext(worker, 10, createdAt);
      const requeued = store.recoverExpiredLeases(new Date(createdAt.getTime() + 11));
      assert.equal(requeued[0]?.state, "retry_pending");

      const second = store.claimNext(worker, 10, new Date(createdAt.getTime() + 20));
      assert.equal(second?.attempt, 2);
      store.heartbeat(first.id, worker.workerId, 2, 10, new Date(createdAt.getTime() + 21));
      const blocked = store.recoverExpiredLeases(new Date(createdAt.getTime() + 32));
      assert.equal(blocked[0]?.state, "needs_recovery");

      const recovered = store.recover(first.id, undefined, new Date(createdAt.getTime() + 33));
      assert.equal(recovered.state, "retry_pending");
      assert.equal(store.summary().retryPending, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not lease work to a worker without the required repository", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-jobs-capability-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      store.create(payload());
      assert.equal(
        store.claimNext({ ...worker, repositoryKeys: ["other"] }),
        undefined
      );
      assert.equal(store.requestCancel(store.list()[0]!.id).state, "cancelled");
      assert.equal(store.summary().cancelled, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit cancellation result after an active cancellation request", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-jobs-cancel-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      const created = store.create(payload(), createdAt);
      store.claimNext(worker, 10_000, createdAt);
      store.heartbeat(created.id, worker.workerId, 1, 10_000, new Date(createdAt.getTime() + 1));
      const requested = store.requestCancel(created.id, "operator requested cancellation", new Date(createdAt.getTime() + 2));
      assert.equal(requested.state, "cancel_requested");
      assert.equal(store.heartbeat(created.id, worker.workerId, 1, 10_000, new Date(createdAt.getTime() + 3)).cancelRequested, true);
      assert.throws(
        () => store.submitResult(created.id, worker.workerId, 1, { status: "succeeded", sessionId: created.sessionId }),
        /cannot accept a non-cancelled result/
      );
      const cancelled = store.submitResult(created.id, worker.workerId, 1, { status: "cancelled", sessionId: created.sessionId }, new Date(createdAt.getTime() + 4));
      assert.equal(cancelled.job.state, "cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leases sandbox jobs only to workers advertising the requested runtime", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-jobs-sandbox-"));
    try {
      const store = new AtomicJobStore(path.join(root, "jobs.json"));
      const sandboxPayload = payload();
      const job = store.create({
        ...sandboxPayload,
        config: {
          ...sandboxPayload.config,
          execution: {
            ...sandboxPayload.config.execution,
            sandbox: {
              runtime: "docker",
              image: `ghcr.io/example/bisectpilot@sha256:${"b".repeat(64)}`,
              network: "none",
              resources: { cpus: 1, memoryMb: 256, pidsLimit: 64, tmpfsMb: 32 },
            },
          },
        },
      });
      assert.equal(store.claimNext(worker, 10_000)?.id, undefined);
      const claimed = store.claimNext({ ...worker, sandboxRuntimes: ["docker"] }, 10_000);
      assert.equal(claimed?.id, job.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
