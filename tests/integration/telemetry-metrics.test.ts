import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as http from "node:http";
import {
  DEFAULT_EXECUTION_POLICY,
  FakeEngine,
  type BisectJobPayload,
  SimpleTracer,
  InMemorySpanExporter,
  type SpanRecord,
  setGlobalTracer,
  defaultMetrics,
  defaultMetricsRegistry,
} from "../../src/index.js";
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

describe("Production Observability & Prometheus Metrics Integration", () => {
  it("exposes Prometheus metrics endpoint, tracks job lifecycle, and propagates trace context", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-telemetry-test-"));
    const daemon = new DaemonService({ stateDir: path.join(root, "daemon"), port: 0 });
    let worker: WorkerService | undefined;

    const spanExporter = new InMemorySpanExporter();
    const tracer = new SimpleTracer(spanExporter);
    setGlobalTracer(tracer);

    try {
      const daemonState = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(daemonState), tokenFile: daemonState.tokenFile });

      // 1. Initial scrape: daemon has metrics endpoint active on loopback
      const initialMetrics = await client.scrapeMetrics();
      assert.ok(initialMetrics.includes("# TYPE bisectpilot_jobs_total counter"));
      assert.ok(initialMetrics.includes("# TYPE bisectpilot_queue_depth gauge"));
      assert.ok(initialMetrics.includes("# TYPE bisectpilot_active_jobs gauge"));
      assert.ok(initialMetrics.includes("# TYPE bisectpilot_registered_workers gauge"));
      assert.ok(initialMetrics.includes("bisectpilot_queue_depth 0"));

      // Verify no sensitive tokens or secret paths in metrics
      assert.ok(!initialMetrics.includes("Bearer"));
      assert.ok(!initialMetrics.includes("token"));

      // 2. Start worker and verify worker registration gauge updates
      worker = new WorkerService({
        stateDir: path.join(root, "worker"),
        serverUrl: daemonBaseUrl(daemonState),
        daemonTokenFile: daemonState.tokenFile,
        repositories: { default: process.cwd() },
        pollMs: 250,
        engine: new FakeEngine(),
      });
      await worker.start();

      // Scrape after worker registered
      const withWorkerMetrics = await client.scrapeMetrics();
      assert.ok(withWorkerMetrics.includes('bisectpilot_registered_workers{state="available"} 1') ||
                withWorkerMetrics.includes('bisectpilot_registered_workers{state="busy"} 0'));

      // 3. Enqueue job within an active trace span
      let enqueuedJobId: string | undefined;
      await tracer.withSpan("client.enqueue_workflow", async (span) => {
        span.setAttribute("workflow.name", "automated-bisect");
        const res = await client.enqueue(payload);
        enqueuedJobId = res.job.id;
      });

      assert.ok(enqueuedJobId);

      // Wait for job completion
      for (let i = 0; i < 30; i++) {
        const s = await client.status();
        if (s.queue.succeeded >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const status = await client.status();
      assert.equal(status.queue.succeeded, 1);

      // 4. Scrape metrics after job completion and verify lifecycle counters and gauges
      const completedMetrics = await client.scrapeMetrics();
      assert.ok(completedMetrics.includes('bisectpilot_jobs_total{state="succeeded"} 1'));
      assert.ok(completedMetrics.includes("bisectpilot_queue_depth 0"));
      assert.ok(completedMetrics.includes("bisectpilot_active_jobs 0"));
      assert.ok(completedMetrics.includes("bisectpilot_job_execution_duration_seconds_count 1"));

      // 5. Verify trace spans were recorded with traceparent propagation
      const spans = spanExporter.getFinishedSpans();
      assert.ok(spans.length >= 2, `Expected at least 2 spans, got ${spans.length}`);

      const clientSpan = spans.find((s: SpanRecord) => s.name === "client.enqueue_workflow");
      assert.ok(clientSpan, "Expected client.enqueue_workflow span");

      // Verify attributes in finished spans are sanitized
      for (const sp of spans) {
        for (const [k, v] of Object.entries(sp.attributes)) {
          if (/token|secret|key|password|cert/i.test(k)) {
            assert.equal(v, "[REDACTED]", `Attribute ${k} was not redacted`);
          }
        }
      }

      // 6. Security tests on /metrics
      // 6a. Loopback with invalid token is rejected with 401
      const daemonUrl = new URL(daemonBaseUrl(daemonState));
      const invalidTokenRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: daemonUrl.hostname,
            port: Number(daemonUrl.port),
            path: "/metrics",
            method: "GET",
            headers: { authorization: "Bearer invalid-wrong-token-12345678901234567890" },
          },
          (res) => {
            resolve({ statusCode: res.statusCode ?? 0 });
          }
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(invalidTokenRes.statusCode, 401, "Loopback with invalid token should be rejected with 401");

      // 6b. Loopback without auth is permitted for local scrapers
      const validLoopbackRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: daemonUrl.hostname,
            port: Number(daemonUrl.port),
            path: "/metrics",
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(Buffer.from(c)));
            res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
          }
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(validLoopbackRes.statusCode, 200);
      assert.ok(validLoopbackRes.body.includes("# TYPE bisectpilot_jobs_total counter"));
    } finally {
      await worker?.stop().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles cancellation and recovery consistently in metrics", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bp-telemetry-cancel-"));
    const daemon = new DaemonService({ stateDir: path.join(root, "daemon"), port: 0 });

    try {
      const daemonState = await daemon.start();
      const client = new DaemonClient({ baseUrl: daemonBaseUrl(daemonState), tokenFile: daemonState.tokenFile });

      // Enqueue job with no workers running
      const jobRes = await client.enqueue(payload);
      const metricsBefore = await client.scrapeMetrics();
      assert.ok(metricsBefore.includes("bisectpilot_queue_depth 1"));

      // Cancel the pending job
      await client.cancel(jobRes.job.id, "cancelled by user");

      const metricsAfter = await client.scrapeMetrics();
      assert.ok(metricsAfter.includes('bisectpilot_jobs_total{state="cancelled"} 1'));
      assert.ok(metricsAfter.includes("bisectpilot_queue_depth 0"));
      assert.ok(metricsAfter.includes("bisectpilot_active_jobs 0"));
    } finally {
      await daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
