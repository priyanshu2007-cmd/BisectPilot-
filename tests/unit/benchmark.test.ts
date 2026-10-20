import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBenchmarkMetric,
  buildBenchmarkStats,
  evaluateBenchmarkRegression,
} from "../../src/domain/benchmark.js";
import type { BenchmarkSpec } from "../../src/contracts/config.js";

test("Feature — Benchmark Parsing, Statistical Aggregation & Regression Evaluation", async (t) => {
  await t.test("parseBenchmarkMetric parses flat JSON number metric", () => {
    const output = JSON.stringify({ latency_ms: 142.5, memory_mb: 64 });
    const res = parseBenchmarkMetric(output, "latency_ms", "ms");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value, 142.5);
    }
  });

  await t.test("parseBenchmarkMetric parses nested JSON metric", () => {
    const output = JSON.stringify({ results: { benchmarks: { duration: 320 } } });
    const res = parseBenchmarkMetric(output, "duration");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value, 320);
    }
  });

  await t.test("parseBenchmarkMetric parses key-value formats", () => {
    const output = "Running test...\nlatency_ms: 185.25 ms\nFinished.";
    const res = parseBenchmarkMetric(output, "latency_ms", "ms");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value, 185.25);
    }
  });

  await t.test("parseBenchmarkMetric parses key = value with no unit specified", () => {
    const output = "ops_per_sec = 45000\n";
    const res = parseBenchmarkMetric(output, "ops_per_sec");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value, 45000);
    }
  });

  await t.test("parseBenchmarkMetric rejects incompatible units", () => {
    const output = "latency: 150 s";
    const res = parseBenchmarkMetric(output, "latency", "ms");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /Incompatible unit/);
    }
  });

  await t.test("parseBenchmarkMetric rejects NaN and Infinity values", () => {
    const nanJson = JSON.stringify({ latency: null });
    assert.equal(parseBenchmarkMetric(nanJson, "latency").ok, false);

    const infText = "latency: Infinity";
    assert.equal(parseBenchmarkMetric(infText, "latency").ok, false);
  });

  await t.test("parseBenchmarkMetric reports missing metric error", () => {
    const output = JSON.stringify({ other_metric: 100 });
    const res = parseBenchmarkMetric(output, "latency_ms");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /Could not parse metric/);
    }
  });

  await t.test("buildBenchmarkStats computes percentiles and sample properties", () => {
    const samples = [100, 105, 102, 108, 101, 110, 103, 104, 107, 106];
    const stats = buildBenchmarkStats(samples, "latency_ms", 2, "ms");
    assert.equal(stats.metric, "latency_ms");
    assert.equal(stats.unit, "ms");
    assert.equal(stats.count, 10);
    assert.equal(stats.warmupRuns, 2);
    assert.ok(stats.mean > 100 && stats.mean < 115);
    assert.ok(stats.stdDev > 0);
    assert.ok(stats.p95 >= stats.median);
    assert.ok(stats.p99 >= stats.p95);
  });

  await t.test("evaluateBenchmarkRegression detects clear higher_is_worse regression", () => {
    const baseline = buildBenchmarkStats([50, 52, 49, 51, 50], "latency_ms", 1, "ms");
    const candidate = buildBenchmarkStats([120, 122, 119, 121, 120], "latency_ms", 1, "ms");
    const config: BenchmarkSpec = {
      metric: "latency_ms",
      threshold: 80,
      direction: "higher_is_worse",
      unit: "ms",
    };

    const res = evaluateBenchmarkRegression({ baseline, candidate, config });
    assert.equal(res.decision, "regression");
    assert.equal(res.isPracticalRegression, true);
    assert.equal(res.isSignificant, true);
    assert.ok(res.absoluteDelta > 60);
    assert.ok(res.relativeDelta > 1.0); // > 100%
  });

  await t.test("evaluateBenchmarkRegression detects relative regression exceeding percentage threshold", () => {
    const baseline = buildBenchmarkStats([100, 101, 99, 100, 102], "duration", 0);
    // 25% increase, threshold is 20% (0.20)
    const candidate = buildBenchmarkStats([125, 126, 124, 125, 127], "duration", 0);
    const config: BenchmarkSpec = {
      metric: "duration",
      relativeRegression: 0.20,
      direction: "higher_is_worse",
    };

    const res = evaluateBenchmarkRegression({ baseline, candidate, config });
    assert.equal(res.decision, "regression");
    assert.equal(res.isPracticalRegression, true);
    assert.ok(res.relativeDelta >= 0.20);
  });

  await t.test("evaluateBenchmarkRegression respects lower_is_worse metric direction", () => {
    // Throughput drops from 1000 ops/s to 400 ops/s
    const baseline = buildBenchmarkStats([1000, 1020, 980, 1010, 990], "throughput", 0, "ops/s");
    const candidate = buildBenchmarkStats([400, 410, 390, 405, 395], "throughput", 0, "ops/s");
    const config: BenchmarkSpec = {
      metric: "throughput",
      threshold: 600, // drops below 600
      direction: "lower_is_worse",
      unit: "ops/s",
    };

    const res = evaluateBenchmarkRegression({ baseline, candidate, config });
    assert.equal(res.decision, "regression");
    assert.equal(res.isPracticalRegression, true);
    assert.ok(res.absoluteDelta < -500);
  });

  await t.test("evaluateBenchmarkRegression requires both practical and statistical significance", () => {
    // Highly precise measurement where change is 0.5ms (statistically detectable with tiny variance, but practical threshold is 10ms)
    const baseline = buildBenchmarkStats([100.0, 100.01, 100.0, 100.02, 100.01], "latency", 0);
    const candidate = buildBenchmarkStats([100.5, 100.51, 100.5, 100.52, 100.51], "latency", 0);
    const config: BenchmarkSpec = {
      metric: "latency",
      threshold: 110.0, // practical threshold not breached
      direction: "higher_is_worse",
    };

    const res = evaluateBenchmarkRegression({ baseline, candidate, config });
    assert.equal(res.decision, "non_regression");
    assert.equal(res.isPracticalRegression, false);
  });

  await t.test("evaluateBenchmarkRegression marks noisy or ambiguous data as inconclusive", () => {
    // High variance overlapping samples, relative threshold 15%
    const baseline = buildBenchmarkStats([50, 150, 40, 160], "latency", 0);
    const candidate = buildBenchmarkStats([70, 170, 60, 180], "latency", 0);
    const config: BenchmarkSpec = {
      metric: "latency",
      threshold: 120,
      direction: "higher_is_worse",
      alpha: 0.01, // strict confidence
    };

    const res = evaluateBenchmarkRegression({ baseline, candidate, config });
    // p-value is high due to huge overlapping variances
    assert.equal(res.isSignificant, false);
    assert.equal(res.decision, "inconclusive");
  });
});
