import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateSampleStats,
  calculatePercentile,
  welchTTest,
  calculateStudentsTPValue,
  logGamma,
  regularizedIncompleteBeta,
} from "../../src/domain/statistics.js";

test("Feature — Pure Statistical Functions & Welch's T-Test", async (t) => {
  await t.test("calculateSampleStats calculates correct mean, variance, stdDev, min, and max", () => {
    const samples = [10, 20, 30, 40, 50];
    const stats = calculateSampleStats(samples);
    assert.equal(stats.count, 5);
    assert.equal(stats.mean, 30);
    // Sample variance: sum of squared diffs / (n - 1) = (400 + 100 + 0 + 100 + 400) / 4 = 1000 / 4 = 250
    assert.equal(stats.variance, 250);
    assert.ok(Math.abs(stats.stdDev - Math.sqrt(250)) < 1e-6);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 50);
  });

  await t.test("calculateSampleStats handles single sample safely with 0 variance", () => {
    const stats = calculateSampleStats([42]);
    assert.equal(stats.count, 1);
    assert.equal(stats.mean, 42);
    assert.equal(stats.variance, 0);
    assert.equal(stats.stdDev, 0);
    assert.equal(stats.min, 42);
    assert.equal(stats.max, 42);
  });

  await t.test("calculateSampleStats throws on empty samples", () => {
    assert.throws(() => calculateSampleStats([]), /Cannot compute sample statistics for empty sample set/);
  });

  await t.test("calculatePercentile computes correct percentiles with linear interpolation", () => {
    const samples = [10, 20, 30, 40, 50];
    assert.equal(calculatePercentile(samples, 0), 10);
    assert.equal(calculatePercentile(samples, 50), 30);
    assert.equal(calculatePercentile(samples, 100), 50);
    // p95 on 5 samples: rank = 0.95 * 4 = 3.8 -> 40 + 0.8 * 10 = 48
    assert.equal(calculatePercentile(samples, 95), 48);
  });

  await t.test("logGamma produces accurate mathematical values", () => {
    // Gamma(1) = 0! = 1 -> ln(1) = 0
    assert.ok(Math.abs(logGamma(1)) < 1e-6);
    // Gamma(2) = 1! = 1 -> ln(1) = 0
    assert.ok(Math.abs(logGamma(2)) < 1e-6);
    // Gamma(5) = 4! = 24 -> ln(24) = 3.17805383
    assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-6);
    // Gamma(0.5) = sqrt(pi) -> ln(sqrt(pi)) = 0.5 * ln(pi)
    assert.ok(Math.abs(logGamma(0.5) - 0.5 * Math.log(Math.PI)) < 1e-6);
  });

  await t.test("regularizedIncompleteBeta behaves properly at boundary values", () => {
    assert.equal(regularizedIncompleteBeta(0, 2, 2), 0);
    assert.equal(regularizedIncompleteBeta(1, 2, 2), 1);
    // At x = 0.5 with symmetric a=b=1 (uniform distribution), I_0.5(1, 1) = 0.5
    assert.ok(Math.abs(regularizedIncompleteBeta(0.5, 1, 1) - 0.5) < 1e-6);
  });

  await t.test("calculateStudentsTPValue calculates known two-tailed p-values", () => {
    // For t = 0, p-value should be 1.0 regardless of df
    assert.equal(calculateStudentsTPValue(0, 10), 1.0);
    // For large t, p-value should approach 0
    assert.ok(calculateStudentsTPValue(10, 10) < 1e-4);
    // Standard critical value for df = 10, two-tailed alpha = 0.05 is t ≈ 2.228
    const pVal = calculateStudentsTPValue(2.228, 10);
    assert.ok(Math.abs(pVal - 0.05) < 0.01);
  });

  await t.test("welchTTest detects significant difference between distinct sample sets", () => {
    const sample1 = [100, 102, 101, 99, 100, 101];
    const sample2 = [150, 152, 149, 151, 150, 153];
    const res = welchTTest(sample1, sample2);
    assert.ok(res.tStatistic > 50);
    assert.ok(res.pValue < 1e-6);
    assert.ok(res.degreesOfFreedom > 5);
  });

  await t.test("welchTTest correctly returns pValue = 1.0 for identical sample sets", () => {
    const sample1 = [100, 100, 100];
    const sample2 = [100, 100, 100];
    const res = welchTTest(sample1, sample2);
    assert.equal(res.tStatistic, 0);
    assert.equal(res.pValue, 1.0);
  });

  await t.test("welchTTest handles unequal sample sizes and unequal variances", () => {
    const sample1 = [10, 12, 11, 13, 9, 10, 12, 11]; // n=8, small variance
    const sample2 = [25, 5, 40, 10]; // n=4, large variance
    const res = welchTTest(sample1, sample2);
    assert.ok(Number.isFinite(res.tStatistic));
    assert.ok(Number.isFinite(res.pValue));
    assert.ok(res.pValue >= 0 && res.pValue <= 1);
    assert.ok(res.degreesOfFreedom > 0);
  });
});
