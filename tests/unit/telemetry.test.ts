import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseTraceParent,
  formatTraceParent,
  generateTraceId,
  generateSpanId,
  sanitizeAttributeValue,
  sanitizeAttributes,
  SimpleTracer,
  InMemorySpanExporter,
  NoopTracer,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  InMemoryAuditEventExporter,
  FileAuditEventExporter,
  verifyLedgerChain,
  appendLedgerEvent,
  readLedgerEvents,
  type LedgerEvent,
  type SpanRecord,
} from "../../src/index.js";

test("parseTraceParent parses valid W3C traceparent headers", () => {
  const parsed = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  assert.ok(parsed);
  assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed.spanId, "00f067aa0ba902b7");
  assert.equal(parsed.traceFlags, 1);
});

test("parseTraceParent rejects invalid or all-zero headers", () => {
  assert.equal(parseTraceParent(null), null);
  assert.equal(parseTraceParent(""), null);
  assert.equal(parseTraceParent("invalid"), null);
  // All zero trace ID or span ID is invalid per W3C spec
  assert.equal(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"), null);
  assert.equal(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"), null);
});

test("formatTraceParent formats TraceContext to W3C string", () => {
  const formatted = formatTraceParent({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: 1,
  });
  assert.equal(formatted, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
});

test("sanitizeAttributeValue redacts sensitive keys and truncates long strings", () => {
  assert.equal(sanitizeAttributeValue("token", "supersecret123"), "[REDACTED]");
  assert.equal(sanitizeAttributeValue("bearer_token", "abc"), "[REDACTED]");
  assert.equal(sanitizeAttributeValue("api_key", "secret"), "[REDACTED]");
  assert.equal(sanitizeAttributeValue("client_cert", "certdata"), "[REDACTED]");
  assert.equal(sanitizeAttributeValue("password", "p@ssword"), "[REDACTED]");

  const longVal = "a".repeat(2000);
  const sanitizedLong = sanitizeAttributeValue("command", longVal);
  assert.ok(typeof sanitizedLong === "string" && sanitizedLong.includes("[TRUNCATED]"));
  assert.ok((sanitizedLong as string).length < 1100);

  // Normal safe attributes preserved
  assert.equal(sanitizeAttributeValue("job.id", "job-123"), "job-123");
  assert.equal(sanitizeAttributeValue("job.attempt", 2), 2);
  assert.equal(sanitizeAttributeValue("success", true), true);
});

test("SimpleTracer creates spans and records them in exporter", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = new SimpleTracer(exporter);

  await tracer.withSpan("parent-operation", async (parentSpan) => {
    parentSpan.setAttribute("session.id", "s-123");
    parentSpan.setAttribute("secret_token", "should-be-redacted");

    await tracer.withSpan("child-operation", async (childSpan) => {
      childSpan.setAttribute("job.id", "j-456");
      childSpan.addEvent("checkpoint", { step: 1 });
    });
  });

  const records = exporter.getFinishedSpans();
  assert.equal(records.length, 2);

  const child = records.find((s: SpanRecord) => s.name === "child-operation");
  const parent = records.find((s: SpanRecord) => s.name === "parent-operation");

  assert.ok(child);
  assert.ok(parent);

  // Parent context propagated
  assert.equal(child.context.traceId, parent.context.traceId);
  assert.equal(child.parentSpanId, parent.context.spanId);

  // Sensitive attribute redacted
  assert.equal(parent.attributes["secret_token"], "[REDACTED]");
  assert.equal(parent.attributes["session.id"], "s-123");
  assert.equal(child.attributes["job.id"], "j-456");
  assert.equal(child.events.length, 1);
  assert.equal(child.events[0]?.name, "checkpoint");
});

test("NoopTracer behaves as zero-overhead no-op", async () => {
  const tracer = new NoopTracer();
  let executed = false;
  const result = await tracer.withSpan("noop-span", (span) => {
    executed = true;
    span.setAttribute("k", "v");
    span.addEvent("event");
    span.setStatus("ok");
    return 42;
  });
  assert.equal(executed, true);
  assert.equal(result, 42);
});

test("Counter behaves properly and formats Prometheus text output", () => {
  const counter = new Counter("test_counter_total", "Test counter help", ["state"]);
  counter.inc(1, { state: "pending" });
  counter.inc({ state: "pending" }, 2);
  counter.inc({ state: "running" });

  assert.equal(counter.get({ state: "pending" }), 3);
  assert.equal(counter.get({ state: "running" }), 1);

  const output = counter.scrape();
  assert.ok(output.includes("# HELP test_counter_total Test counter help"));
  assert.ok(output.includes("# TYPE test_counter_total counter"));
  assert.ok(output.includes('test_counter_total{state="pending"} 3'));
  assert.ok(output.includes('test_counter_total{state="running"} 1'));
});

test("Gauge behaves properly and avoids negative values on dec", () => {
  const gauge = new Gauge("test_gauge", "Test gauge help");
  gauge.set(5);
  assert.equal(gauge.get(), 5);
  gauge.inc(2);
  assert.equal(gauge.get(), 7);
  gauge.dec(3);
  assert.equal(gauge.get(), 4);
  gauge.dec(10);
  assert.equal(gauge.get(), 0); // Bounded at 0

  const output = gauge.scrape();
  assert.ok(output.includes("# HELP test_gauge Test gauge help"));
  assert.ok(output.includes("# TYPE test_gauge gauge"));
  assert.ok(output.includes("test_gauge 0"));
});

test("Histogram records values into buckets and calculates sum/count", () => {
  const hist = new Histogram("test_duration_seconds", "Test histogram help", {
    buckets: [0.1, 0.5, 1.0, 5.0],
  });

  hist.observe(0.05);
  hist.observe(0.25);
  hist.observe(0.75);
  hist.observe(2.0);

  const stats = hist.get();
  assert.equal(stats.count, 4);
  assert.equal(stats.sum, 3.05);
  assert.equal(stats.buckets["0.1"], 1);
  assert.equal(stats.buckets["0.5"], 2);
  assert.equal(stats.buckets["1"], 3);
  assert.equal(stats.buckets["5"], 4);
  assert.equal(stats.buckets["+Inf"], 4);

  const output = hist.scrape();
  assert.ok(output.includes('test_duration_seconds_bucket{le="0.1"} 1'));
  assert.ok(output.includes('test_duration_seconds_bucket{le="0.5"} 2'));
  assert.ok(output.includes('test_duration_seconds_bucket{le="+Inf"} 4'));
  assert.ok(output.includes("test_duration_seconds_sum 3.05"));
  assert.ok(output.includes("test_duration_seconds_count 4"));
});

test("MetricsRegistry prevents duplicate registration and scrapes all metrics", () => {
  const registry = new MetricsRegistry();
  const c1 = registry.registerCounter("test_count", "help 1");
  const c2 = registry.registerCounter("test_count", "help 2");
  assert.equal(c1, c2); // Reused, no duplicate error

  c1.inc(5);
  const scraped = registry.scrape();
  assert.ok(scraped.includes("test_count 5"));
});

test("AuditEventExporters export verified ledger events and reject tampered chains", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-audit-test-"));
  const ledgerPath = path.join(tmpDir, "audit.jsonl");
  const exportPath = path.join(tmpDir, "exported-audit.jsonl");

  try {
    const memoryExporter = new InMemoryAuditEventExporter();
    const fileExporter = new FileAuditEventExporter(exportPath);

    // Build verified chain of events using standard appendLedgerEvent
    const e1 = appendLedgerEvent(ledgerPath, {
      type: "session_created",
      sessionId: "s-1",
      goodSha: "g1",
      badSha: "b1",
      worktreePath: "/tmp/wt",
      overlayHashes: {},
    });
    const e2 = appendLedgerEvent(ledgerPath, {
      type: "transition",
      sessionId: "s-1",
      from: "created",
      to: "preflight_running",
    });

    const events = readLedgerEvents(ledgerPath);
    const chainCheck = verifyLedgerChain(events);
    assert.equal(chainCheck.valid, true);

    const memRes = await memoryExporter.exportEvents(events);
    assert.equal(memRes.success, true);
    assert.equal(memRes.exportedCount, 2);
    assert.equal(memoryExporter.getExportedEvents().length, 2);

    const fileRes = await fileExporter.exportEvents(events);
    assert.equal(fileRes.success, true);
    assert.equal(fileRes.exportedCount, 2);
    assert.ok(fs.existsSync(exportPath));
    const content = fs.readFileSync(exportPath, "utf-8").trim().split("\n");
    assert.equal(content.length, 2);

    // Tampered chain (sequence jump or modified eventHash)
    const tampered = [
      ...events,
      {
        ...e2,
        seq: 4, // sequence jump
        eventHash: "tampered-hash-value",
      },
    ];

    const tamperedCheck = verifyLedgerChain(tampered);
    assert.equal(tamperedCheck.valid, false);

    const tamperedRes = await memoryExporter.exportEvents(tampered);
    assert.equal(tamperedRes.success, false);
    assert.equal(tamperedRes.exportedCount, 0);
    assert.ok(tamperedRes.error?.includes("verification failed"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
