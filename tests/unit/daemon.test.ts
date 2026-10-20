import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY, type BisectJobPayload, type WorkerCapabilities } from "../../src/contracts/index.js";
import { DaemonClient, DaemonService, daemonBaseUrl } from "../../src/daemon/index.js";

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
      oracle: { mode: "in-tree", command: { command: "node", args: ["check.mjs"], timeoutMs: 1_000 } },
      execution: { ...DEFAULT_EXECUTION_POLICY, confirmBeforeExecutingCode: false },
    },
    repository: { strategy: "preprovisioned", key: "default", expectedGoodSha: GOOD_SHA, expectedBadSha: BAD_SHA },
  };
}

const worker: WorkerCapabilities = {
  workerId: "worker-daemon-test",
  protocolVersion: 1,
  jobTypes: ["bisect"],
  repositoryKeys: ["default"],
  platform: "test",
  architecture: "test",
  maxConcurrentJobs: 1,
};

describe("daemon protocol", () => {
  it("authenticates workers, leases jobs, and records results over loopback HTTP", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-"));
    const daemon = new DaemonService({ stateDir: root, port: 0 });
    try {
      const state = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
      assert.deepEqual(await client.health(), { ok: true, protocolVersion: 1 });
      await client.registerWorker(worker);
      const queued = await client.enqueue(payload());
      const polled = await client.poll(worker);
      assert.equal(polled.job?.id, queued.job.id);
      assert.equal(polled.job?.state, "leased");

      const heartbeat = await client.heartbeat(polled.job!.id, worker.workerId, polled.job!.attempt);
      assert.equal(heartbeat.cancelRequested, false);
      await client.result(polled.job!.id, worker.workerId, polled.job!.attempt, {
        status: "succeeded",
        sessionId: polled.job!.sessionId,
        detail: "test result",
      });

      const status = await client.status();
      assert.equal(status.queue.succeeded, 1);
      assert.equal(status.workers[0]?.capabilities.workerId, worker.workerId);
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a wrong token and refuses plaintext non-loopback binds", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-auth-"));
    try {
      const daemon = new DaemonService({ stateDir: root, port: 0 });
      const state = await daemon.start();
      const wrongToken = path.join(root, "wrong.token");
      writeFileSync(wrongToken, `${"f".repeat(64)}\n`, { encoding: "utf-8", mode: 0o600 });
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: wrongToken });
      await assert.rejects(() => client.status(), /Daemon request failed \(401\)/);
      await daemon.stop();

      await assert.rejects(
        () => new DaemonService({ stateDir: path.join(root, "remote"), host: "0.0.0.0", port: 0 }).start(),
        /without TLS/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid and oversized protocol bodies before queue mutation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-input-"));
    const daemon = new DaemonService({ stateDir: root, port: 0 });
    try {
      const state = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
      await assert.rejects(
        () => client.enqueue({ invalid: true } as unknown as BisectJobPayload),
        /Daemon request failed \(400\)/
      );
      const oversized = await new Promise<number>((resolve, reject) => {
        const token = readFileSync(state.tokenFile, "utf-8").trim();
        const body = JSON.stringify({ payload: "x".repeat(300_000) });
        const req = http.request(
          {
            hostname: state.host,
            port: state.port,
            path: "/v1/jobs",
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          }
        );
        req.on("error", reject);
        req.end(body);
      });
      assert.equal(oversized, 400);
      const queued = await client.enqueue(payload());
      const cancelled = await client.cancel(queued.job.id, "test cancellation");
      assert.equal(cancelled.job.state, "cancelled");
      assert.equal((await client.status()).queue.cancelled, 1);
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a second daemon owner for the same state directory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-lock-"));
    const first = new DaemonService({ stateDir: root, port: 0 });
    try {
      await first.start();
      const second = new DaemonService({ stateDir: root, port: 0 });
      await assert.rejects(() => second.start(), /active PID/);
    } finally {
      await first.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates worker conclusion fields before persisting a result", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-result-"));
    const daemon = new DaemonService({ stateDir: root, port: 0 });
    try {
      const state = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(state), tokenFile: state.tokenFile });
      await client.registerWorker(worker);
      const queued = await client.enqueue(payload());
      const polled = await client.poll(worker);
      assert.equal(polled.job?.id, queued.job.id);
      await client.heartbeat(polled.job!.id, worker.workerId, polled.job!.attempt);
      await assert.rejects(
        () => client.result(polled.job!.id, worker.workerId, polled.job!.attempt, {
          status: "succeeded",
          sessionId: polled.job!.sessionId,
          conclusion: { outcome: "forged", explanation: "bad", skippedShas: [] },
        }),
        /Daemon request failed \(400\)/
      );
      assert.equal((await client.status()).queue.running, 1);
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
