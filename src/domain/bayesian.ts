/**
 * Bayesian Noisy-Oracle Culprit Finding Model (Section 26.4 & 26.5)
 * Based on Google's Flake Aware Culprit Finding (ICST 2023).
 */

export function calculateBayesianPosterior(passes: number, fails: number, flakeRate = 0.1): number {
  const boundedFlake = Math.max(0.0001, Math.min(0.4999, flakeRate));
  const diff = passes - fails;
  const r = (1 - boundedFlake) / boundedFlake;
  // Bounded exponent to prevent numerical overflow/underflow
  const boundedDiff = Math.max(-50, Math.min(50, diff));
  const rPow = Math.pow(r, boundedDiff);
  return 1 / (1 + rPow);
}

export type BayesianDecision = "good" | "bad" | "inconclusive";

export function evaluateBayesianDecision(params: {
  readonly passes: number;
  readonly fails: number;
  readonly flakeRate?: number;
  readonly confidenceThreshold?: number;
}): {
  readonly decision: BayesianDecision;
  readonly posteriorBad: number;
  readonly posteriorGood: number;
} {
  const threshold = params.confidenceThreshold ?? 0.9;
  const posteriorBad = calculateBayesianPosterior(params.passes, params.fails, params.flakeRate ?? 0.1);
  const posteriorGood = 1 - posteriorBad;

  if (posteriorBad >= threshold) {
    return { decision: "bad", posteriorBad, posteriorGood };
  }
  if (posteriorGood >= threshold) {
    return { decision: "good", posteriorBad, posteriorGood };
  }
  return { decision: "inconclusive", posteriorBad, posteriorGood };
}
