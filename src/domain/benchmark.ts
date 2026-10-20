/**
 * Benchmark Domain: Metric Extraction, Configuration, and Performance Regression Evaluation
 */

import {
  calculateSampleStats,
  welchTTest,
  type SampleStatistics,
} from "./statistics.js";

export type BenchmarkDirection = "higher_is_worse" | "lower_is_worse";

export interface BenchmarkSpec {
  readonly metric: string;
  readonly unit?: string;
  readonly threshold?: number;
  readonly relativeRegression?: number; // e.g. 0.15 for 15%
  readonly direction?: BenchmarkDirection;
  readonly warmup?: number;
  readonly minSamples?: number;
  readonly maxSamples?: number;
  readonly alpha?: number;
}

export interface BenchmarkStats extends SampleStatistics {
  readonly metric: string;
  readonly unit?: string;
  readonly warmupRuns: number;
  readonly rawSamples: readonly number[];
}

export interface BenchmarkEvaluationResult {
  readonly decision: "regression" | "non_regression" | "inconclusive";
  readonly reason: string;
  readonly baseline: BenchmarkStats;
  readonly candidate: BenchmarkStats;
  readonly absoluteDelta: number;
  readonly relativeDelta: number;
  readonly tStatistic: number;
  readonly degreesOfFreedom: number;
  readonly pValue: number;
  readonly alpha: number;
  readonly isSignificant: boolean;
  readonly isPracticalRegression: boolean;
  readonly direction: BenchmarkDirection;
}

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strictly parses a numeric metric from stdout.
 * Supports structured JSON and plain-text/key-value output.
 */
export function parseBenchmarkMetric(
  stdout: string,
  metricName: string,
  expectedUnit?: string
): { ok: true; value: number; unit?: string } | { ok: false; error: string } {
  const clean = stripAnsi(stdout).trim();
  if (clean.length === 0) {
    return { ok: false, error: "Empty command output; no metric could be extracted" };
  }

function extractNumericMetricFromObject(
  node: unknown,
  metricName: string
): { value: number; unit?: string } | null {
  if (!node || typeof node !== "object") return null;
  const lowerTarget = metricName.toLowerCase();

  if (Array.isArray(node)) {
    for (const item of node) {
      const res = extractNumericMetricFromObject(item, metricName);
      if (res) return res;
    }
    return null;
  }

  const obj = node as Record<string, unknown>;

  // 1. Direct or case-insensitive key lookup
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerTarget && typeof v === "number" && Number.isFinite(v)) {
      const unit = typeof obj.unit === "string" ? obj.unit : undefined;
      return { value: v, ...(unit ? { unit } : {}) };
    }
  }

  // 2. { metric: "name", value: 123 } pattern
  if (
    (obj.metric === metricName || obj.name === metricName) &&
    typeof obj.value === "number" &&
    Number.isFinite(obj.value)
  ) {
    const unit = typeof obj.unit === "string" ? obj.unit : undefined;
    return { value: obj.value, ...(unit ? { unit } : {}) };
  }

  // 3. Recurse into nested objects
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const res = extractNumericMetricFromObject(v, metricName);
      if (res) return res;
    }
  }

  return null;
}

  // 1. Try JSON parsing
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (typeof parsed === "number") {
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: `Raw numeric output is not a finite number (${parsed})` };
      }
      return { ok: true, value: parsed };
    }

    if (parsed && typeof parsed === "object") {
      const extracted = extractNumericMetricFromObject(parsed, metricName);
      if (extracted) {
        if (expectedUnit && extracted.unit && extracted.unit.toLowerCase() !== expectedUnit.toLowerCase()) {
          return { ok: false, error: `Incompatible unit: expected ${expectedUnit} but received ${extracted.unit}` };
        }
        return { ok: true, value: extracted.value, ...(extracted.unit ? { unit: extracted.unit } : {}) };
      }
    }
  } catch {
    // Non-JSON output; proceed to regex extraction
  }

  // 2. Key-value text matching: e.g. "latency_ms: 145.2 ms" or "latency_ms = 145.2"
  const esc = escapeRegex(metricName);
  const kvRegex = new RegExp(
    `(?:^|[\\s,;])${esc}\\s*[:=]\\s*([+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?:\\s*([a-zA-Z/%_]+))?`,
    "im"
  );
  const match = kvRegex.exec(clean);
  if (match) {
    const rawNum = match[1]!;
    const val = Number(rawNum);
    if (!Number.isFinite(val)) {
      return { ok: false, error: `Parsed value "${rawNum}" for metric "${metricName}" is not a finite number` };
    }
    const unit = match[2] ? match[2].trim() : undefined;
    if (expectedUnit && unit && unit.toLowerCase() !== expectedUnit.toLowerCase()) {
      return { ok: false, error: `Incompatible unit: expected ${expectedUnit} but received ${unit}` };
    }
    return { ok: true, value: val, ...(unit ? { unit } : {}) };
  }

  // 3. Fallback: single standalone number on the last non-empty line
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1]!;
    const lineNumMatch = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\\d+)?)(?:\s*([a-zA-Z/%_]+))?$/.exec(lastLine);
    if (lineNumMatch) {
      const val = Number(lineNumMatch[1]!);
      if (Number.isFinite(val)) {
        const unit = lineNumMatch[2] ? lineNumMatch[2].trim() : undefined;
        if (expectedUnit && unit && unit.toLowerCase() !== expectedUnit.toLowerCase()) {
          return { ok: false, error: `Incompatible unit: expected ${expectedUnit} but received ${unit}` };
        }
        return { ok: true, value: val, ...(unit ? { unit } : {}) };
      }
    }
  }

  return {
    ok: false,
    error: `Could not parse metric "${metricName}" from command output. Output must contain "${metricName}: <number>" or JSON with key "${metricName}".`,
  };
}

/**
 * Creates BenchmarkStats from valid samples and metadata.
 */
export function buildBenchmarkStats(
  samples: readonly number[],
  metric: string,
  warmupRuns: number,
  unit?: string
): BenchmarkStats {
  const base = calculateSampleStats(samples);
  return {
    ...base,
    metric,
    ...(unit ? { unit } : {}),
    warmupRuns,
    rawSamples: [...samples],
  };
}

/**
 * Evaluates a candidate's benchmark samples against a baseline distribution.
 */
export function evaluateBenchmarkRegression(params: {
  readonly baseline: BenchmarkStats;
  readonly candidate: BenchmarkStats;
  readonly config: BenchmarkSpec;
}): BenchmarkEvaluationResult {
  const { baseline, candidate, config } = params;
  const direction: BenchmarkDirection = config.direction ?? "higher_is_worse";
  const isHigherWorse = direction === "higher_is_worse";

  const absoluteDelta = candidate.mean - baseline.mean;
  const relativeDelta = baseline.mean !== 0 ? absoluteDelta / Math.abs(baseline.mean) : 0;

  // Practical significance evaluation
  const matchesAbsolute =
    config.threshold !== undefined
      ? isHigherWorse
        ? candidate.mean >= config.threshold
        : candidate.mean <= config.threshold
      : true;

  const matchesRelative =
    config.relativeRegression !== undefined
      ? isHigherWorse
        ? relativeDelta >= config.relativeRegression
        : -relativeDelta >= config.relativeRegression
      : config.threshold === undefined
        ? isHigherWorse
          ? relativeDelta >= 0.10
          : -relativeDelta >= 0.10
        : true;

  const isPracticalRegression = matchesAbsolute && matchesRelative;

  // Statistical significance evaluation using Welch's t-test
  const tResult = welchTTest(baseline.rawSamples, candidate.rawSamples);
  const alpha = config.alpha ?? 0.05;

  // Check statistical significance in the regression direction
  const isSignificantlyWorse =
    tResult.pValue < alpha &&
    (isHigherWorse ? tResult.tStatistic > 0 : tResult.tStatistic < 0);

  const isSignificantlyBetterOrEqual =
    tResult.pValue < alpha &&
    (isHigherWorse ? tResult.tStatistic < 0 : tResult.tStatistic > 0);

  let decision: "regression" | "non_regression" | "inconclusive";
  let reason: string;

  const pct = (relativeDelta * 100).toFixed(2);
  const sign = relativeDelta >= 0 ? "+" : "";
  const unitStr = config.unit ? ` ${config.unit}` : "";

  if (isPracticalRegression && isSignificantlyWorse) {
    decision = "regression";
    reason = `Statistically significant performance regression detected: mean shifted by ${sign}${absoluteDelta.toFixed(2)}${unitStr} (${sign}${pct}%) from baseline ${baseline.mean.toFixed(2)}${unitStr} to ${candidate.mean.toFixed(2)}${unitStr} (Welch t=${tResult.tStatistic.toFixed(2)}, df=${tResult.degreesOfFreedom.toFixed(1)}, p=${tResult.pValue.toFixed(5)} < ${alpha})`;
  } else if (!isPracticalRegression) {
    if (isSignificantlyBetterOrEqual) {
      decision = "non_regression";
      reason = `Candidate demonstrates performance improvement or no regression: mean shifted by ${sign}${absoluteDelta.toFixed(2)}${unitStr} (${sign}${pct}%) from baseline ${baseline.mean.toFixed(2)}${unitStr} to ${candidate.mean.toFixed(2)}${unitStr}`;
    } else {
      decision = "non_regression";
      reason = `Candidate within acceptable performance tolerance: mean ${candidate.mean.toFixed(2)}${unitStr} vs baseline ${baseline.mean.toFixed(2)}${unitStr} (${sign}${pct}% delta)`;
    }
  } else {
    // Practical criteria met, but high noise / variance resulted in p >= alpha
    decision = "inconclusive";
    reason = `Observed performance degradation (${sign}${pct}%) is not statistically significant due to measurement variance (Welch t=${tResult.tStatistic.toFixed(2)}, p=${tResult.pValue.toFixed(4)} >= ${alpha})`;
  }

  return {
    decision,
    reason,
    baseline,
    candidate,
    absoluteDelta,
    relativeDelta,
    tStatistic: tResult.tStatistic,
    degreesOfFreedom: tResult.degreesOfFreedom,
    pValue: tResult.pValue,
    alpha,
    isSignificant: isSignificantlyWorse,
    isPracticalRegression,
    direction,
  };
}
