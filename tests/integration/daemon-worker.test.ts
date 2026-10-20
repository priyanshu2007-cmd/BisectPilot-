import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EXECUTION_POLICY, FakeEngine, type BisectJobPayload } from "../../src/index.js";
import { DaemonClient, DaemonService, daemonBaseUrl } from "../../src/daemon/index.js";
import { WorkerService } from "../../src/worker/index.js";

const payload: BisectJobPayload = {
  config: {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: "/tmp/daemon-repo-template",
    workingDirectory: ".",
    goodRef: "1111111111111111111111111111111111111111",
    badRef: "9999999999999999999999999999999999999999",
    oracle: { mode: "in-tree", command: { command: "node", args: ["check.mjs"], timeoutMs: 1_000 } },
    execution: { ...DEFAULT_EXECUTION_POLICY, confirmBeforeExecutingCode: false },
  },
  repository: {
    strategy: "preprovisioned",
    key: "default",
    expectedGoodSha: "1111111111111111111111111111111111111111",
    expectedBadSha: "9999999999999999999999999999999999999999",
  },
};

describe("daemon and pull worker integration", () => {
  it("executes one authenticated queued job through a loopback worker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-daemon-worker-"));
    const daemon = new DaemonService({ stateDir: path.join(root, "daemon"), port: 0 });
    let worker: WorkerService | undefined;
    try {
      const daemonState = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(daemonState), tokenFile: daemonState.tokenFile });
      worker = new WorkerService({
        stateDir: path.join(root, "worker"),
        serverUrl: daemonBaseUrl(daemonState),
        daemonTokenFile: daemonState.tokenFile,
        repositories: { default: process.cwd() },
        pollMs: 250,
        engine: new FakeEngine(),
      });
      await worker.start();
      const job = await client.enqueue(payload);

      for (let i = 0; i < 20; i++) {
        if ((await client.status()).queue.succeeded === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const status = await client.status();
      assert.equal(status.queue.succeeded, 1);
      assert.equal((await client.getJob(job.job.id)).result !== null, true);
    } finally {
      await worker?.stop().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
