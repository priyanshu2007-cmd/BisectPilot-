/**
 * Statistical Analysis & Benchmark Testing Domain
 * Pure functions for sample statistics, Welch's t-test, and Student's t-distribution p-values.
 */

export interface SampleStatistics {
  readonly count: number;
  readonly mean: number;
  readonly variance: number;
  readonly stdDev: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export function calculatePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const normalizedP = p > 1 ? p / 100 : p;
  const clampedP = Math.max(0, Math.min(1, normalizedP));
  const index = clampedP * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return (1 - weight) * sorted[lower]! + weight * sorted[upper]!;
}

export function calculateSampleStats(samples: readonly number[]): SampleStatistics {
  const n = samples.length;
  if (n === 0) {
    throw new Error("Cannot compute sample statistics for empty sample set");
  }

  let sum = 0;
  let min = samples[0]!;
  let max = samples[0]!;
  for (const v of samples) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;

  let sumSqDiff = 0;
  for (const v of samples) {
    const diff = v - mean;
    sumSqDiff += diff * diff;
  }
  const variance = n > 1 ? sumSqDiff / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);

  const sorted = [...samples].sort((a, b) => a - b);
  const median = calculatePercentile(sorted, 0.5);
  const p95 = calculatePercentile(sorted, 0.95);
  const p99 = calculatePercentile(sorted, 0.99);

  return {
    count: n,
    mean,
    variance,
    stdDev,
    median,
    p95,
    p99,
    min,
    max,
  };
}

const LANCZOS_COEFFICIENTS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.138571095836526,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  let zAdj = z - 1;
  let x = LANCZOS_COEFFICIENTS[0]!;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i++) {
    x += LANCZOS_COEFFICIENTS[i]! / (zAdj + i);
  }
  const t = zAdj + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zAdj + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularized incomplete beta function I_x(a, b)
 * Computed via continued fraction expansion (Lentz's method).
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry transformation if x > (a + 1)/(a + b + 2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  const TINY = 1e-30;
  const maxIterations = 200;
  const epsilon = 1e-12;

  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const factor = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta) / a;

  let f = 1;
  let c = 1;
  let d = 0;

  for (let m = 0; m <= maxIterations; m++) {
    // Numerator coefficients for continued fraction
    let dNum: number;
    if (m === 0) {
      dNum = 1;
    } else {
      const k = m / 2;
      if (m % 2 === 0) {
        dNum = (k * (b - k) * x) / ((a + 2 * k - 1) * (a + 2 * k));
      } else {
        const kOdd = (m - 1) / 2;
        dNum = -((a + kOdd) * (a + b + kOdd) * x) / ((a + 2 * kOdd) * (a + 2 * kOdd + 1));
      }
    }

    d = 1 + dNum * d;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;

    c = 1 + dNum / c;
    if (Math.abs(c) < TINY) c = TINY;

    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < epsilon) {
      break;
    }
  }

  const result = factor * (f - 1);
  return Math.max(0, Math.min(1, result));
}

/**
 * Two-tailed p-value for Student's t-distribution with df degrees of freedom.
 */
export function calculateStudentsTPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) {
    return 1.0;
  }
  const absT = Math.abs(t);
  if (absT === 0) {
    return 1.0;
  }
  const x = df / (df + absT * absT);
  const p = regularizedIncompleteBeta(x, df / 2, 0.5);
  return Math.max(0, Math.min(1, p));
}

export interface WelchTTestResult {
  readonly tStatistic: number;
  readonly degreesOfFreedom: number;
  readonly pValue: number;
  readonly standardError: number;
  readonly meanDifference: number;
}

/**
 * Welch's two-sample t-test for unequal variances.
 * Compares candidate sample set against baseline sample set.
 */
export function welchTTest(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[]
): WelchTTestResult {
  const n1 = baselineSamples.length;
  const n2 = candidateSamples.length;

  if (n1 === 0 || n2 === 0) {
    return {
      tStatistic: 0,
      degreesOfFreedom: 1,
      pValue: 1.0,
      standardError: 0,
      meanDifference: 0,
    };
  }

  const s1 = calculateSampleStats(baselineSamples);
  const s2 = calculateSampleStats(candidateSamples);

  const meanDiff = s2.mean - s1.mean;

  const v1 = s1.variance / n1;
  const v2 = s2.variance / n2;
  const se = Math.sqrt(v1 + v2);

  if (se === 0 || !Number.isFinite(se)) {
    if (Math.abs(meanDiff) < 1e-12) {
      return {
        tStatistic: 0,
        degreesOfFreedom: Math.max(1, n1 + n2 - 2),
        pValue: 1.0,
        standardError: 0,
        meanDifference: 0,
      };
    }
    // Zero variance but different means -> infinitely significant difference
    // Zero variance but different means -> extreme significant difference (bound to finite for JSON serializability)
    const infT = meanDiff > 0 ? 1e6 : -1e6;
    return {
      tStatistic: infT,
      degreesOfFreedom: Math.max(1, n1 + n2 - 2),
      pValue: 0.0,
      standardError: 0,
      meanDifference: meanDiff,
    };
  }

  const t = meanDiff / se;

  // Welch-Satterthwaite degrees of freedom
  const numDf = (v1 + v2) * (v1 + v2);
  const denDf = (n1 > 1 ? (v1 * v1) / (n1 - 1) : 0) + (n2 > 1 ? (v2 * v2) / (n2 - 1) : 0);
  const df = denDf > 0 ? numDf / denDf : Math.max(1, n1 + n2 - 2);

  const pValue = calculateStudentsTPValue(t, df);

  return {
    tStatistic: t,
    degreesOfFreedom: Math.max(1, df),
    pValue,
    standardError: se,
    meanDifference: meanDiff,
  };
}

export function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

export interface MannWhitneyUTestResult {
  readonly uStatistic: number;
  readonly u1: number;
  readonly u2: number;
  readonly zScore: number;
  readonly pValue: number;
  readonly rankSum1: number;
  readonly rankSum2: number;
}

/**
 * Mann-Whitney U test (Wilcoxon rank-sum test) for non-parametric sample comparison.
 * Compares candidate sample set against baseline sample set without assuming normality.
 */
export function mannWhitneyUTest(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[]
): MannWhitneyUTestResult {
  const n1 = baselineSamples.length;
  const n2 = candidateSamples.length;
  if (n1 === 0 || n2 === 0) {
    return {
      uStatistic: 0,
      u1: 0,
      u2: 0,
      zScore: 0,
      pValue: 1.0,
      rankSum1: 0,
      rankSum2: 0,
    };
  }

  interface Observation {
    val: number;
    group: 1 | 2;
  }
  const combined: Observation[] = [
    ...baselineSamples.map((val) => ({ val, group: 1 as const })),
    ...candidateSamples.map((val) => ({ val, group: 2 as const })),
  ];

  combined.sort((a, b) => a.val - b.val);

  let rankSum1 = 0;
  let rankSum2 = 0;
  const nTotal = n1 + n2;
  let tieSumCorrection = 0;

  let i = 0;
  while (i < nTotal) {
    let j = i;
    while (j < nTotal && combined[j]!.val === combined[i]!.val) {
      j++;
    }
    const tieCount = j - i;
    const averageRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (combined[k]!.group === 1) rankSum1 += averageRank;
      else rankSum2 += averageRank;
    }
    if (tieCount > 1) {
      tieSumCorrection += (tieCount * tieCount * tieCount - tieCount);
    }
    i = j;
  }

  const u1 = rankSum1 - (n1 * (n1 + 1)) / 2;
  const u2 = rankSum2 - (n2 * (n2 + 1)) / 2;
  const uStatistic = Math.min(u1, u2);

  const meanU = (n1 * n2) / 2;
  const varianceCorrection = nTotal > 1 ? tieSumCorrection / (nTotal * (nTotal - 1)) : 0;
  const stdU = Math.sqrt(((n1 * n2) / 12) * Math.max(0, nTotal + 1 - varianceCorrection));

  let zScore = 0;
  let pValue = 1.0;
  if (stdU > 0) {
    const diff = uStatistic - meanU;
    const correctedDiff = diff > 0 ? diff - 0.5 : diff < 0 ? diff + 0.5 : 0;
    zScore = correctedDiff / stdU;
    const absZ = Math.abs(zScore);
    pValue = Math.max(0, Math.min(1, 1 - erf(absZ / Math.SQRT2)));
  } else if (u1 !== u2) {
    pValue = 0.0;
  }

  return {
    uStatistic,
    u1,
    u2,
    zScore,
    pValue,
    rankSum1,
    rankSum2,
  };
}
