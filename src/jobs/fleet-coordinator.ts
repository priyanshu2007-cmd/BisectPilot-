import { randomUUID } from "node:crypto";
import type {
  BisectJobPayload,
  JobRecord,
  JobResult,
  JobType,
  WorkerCapabilities,
} from "../contracts/index.js";
import { evaluateBayesianDecision } from "../domain/bayesian.js";
import {
  evaluateBenchmarkRegression,
  buildBenchmarkStats,
  type BenchmarkSpec,
  type BenchmarkEvaluationResult,
  type BenchmarkStats,
} from "../domain/benchmark.js";
import { defaultMetrics, getTracer } from "../telemetry/index.js";
import {
  AtomicJobStore,
  isWorkerEligible,
  type CreateJobOptions,
} from "./index.js";

export interface NoisySamplingBatchOptions {
  readonly store: AtomicJobStore;
  readonly parentJobId: string;
  readonly revisionSha: string;
  readonly basePayload: BisectJobPayload;
  readonly minSamples?: number;
  readonly maxSamples?: number;
  readonly confidenceThreshold?: number;
  readonly flakeRate?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly requiredCapabilities?: CreateJobOptions["requiredCapabilities"];
}

export interface NoisySamplingDecision {
  readonly decision: "good" | "bad" | "inconclusive" | "aborted";
  readonly revisionSha: string;
  readonly passes: number;
  readonly fails: number;
  readonly skips: number;
  readonly totalEvaluated: number;
  readonly posteriorBad: number;
  readonly posteriorGood: number;
  readonly confidenceThreshold: number;
  readonly sampleJobIds: readonly string[];
  readonly acceptedSampleIds: readonly string[];
  readonly earlyStopped: boolean;
  readonly explanation: string;
}

export interface BenchmarkSamplingBatchOptions {
  readonly store: AtomicJobStore;
  readonly parentJobId: string;
  readonly baselineSha: string;
  readonly candidateSha: string;
  readonly basePayload: BisectJobPayload;
  readonly benchmarkSpec: BenchmarkSpec;
  readonly environmentIdentity: NonNullable<WorkerCapabilities["environmentIdentity"]>;
  readonly minSamples?: number;
  readonly maxSamples?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export interface BenchmarkSamplingDecision {
  readonly decision: "regression" | "non_regression" | "inconclusive" | "aborted";
  readonly explanation: string;
  readonly baselineSha: string;
  readonly candidateSha: string;
  readonly baselineMeasurements: readonly number[];
  readonly candidateMeasurements: readonly number[];
  readonly evaluation?: BenchmarkEvaluationResult;
  readonly sampleJobIds: readonly string[];
  readonly earlyStopped: boolean;
}

export interface FleetCapacityReport {
  readonly totalWorkers: number;
  readonly eligibleWorkers: number;
  readonly totalConcurrencyCapacity: number;
  readonly activeConcurrencyUtilized: number;
}

export class FleetCoordinator {
  /**
   * Evaluates available worker fleet capacity for a given job type and requirements.
   */
  static getFleetCapacity(
    store: AtomicJobStore,
    workers: Iterable<{ readonly capabilities: WorkerCapabilities; readonly lastSeenAt: string }>,
    jobType: JobType = "bisect",
    required?: JobRecord["requiredCapabilities"]
  ): FleetCapacityReport {
    const activeJobs = store.list().filter((j) => j.state === "leased" || j.state === "running");
    let totalWorkers = 0;
    let eligibleWorkers = 0;
    let totalCapacity = 0;

    for (const worker of workers) {
      totalWorkers++;
      const maxJobs = worker.capabilities.maxConcurrentJobs ?? 1;
      totalCapacity += maxJobs;

      if (required) {
        if (isWorkerEligible(worker.capabilities, required, jobType)) {
          eligibleWorkers++;
        }
      } else if (worker.capabilities.jobTypes.includes(jobType)) {
        eligibleWorkers++;
      }
    }

    return {
      totalWorkers,
      eligibleWorkers,
      totalConcurrencyCapacity: totalCapacity,
      activeConcurrencyUtilized: activeJobs.length,
    };
  }

  /**
   * Fans out independent sample jobs for Bayesian noisy-oracle evaluation,
   * gathers completed sample results, stops early when confidence threshold is reached,
   * and cancels remaining unneeded sample jobs.
   */
  static async scheduleNoisyOracleBatch(
    options: NoisySamplingBatchOptions
  ): Promise<NoisySamplingDecision> {
    const tracer = getTracer("bisectpilot.fleet");
    return tracer.withSpan("fleet.schedule_noisy_oracle_batch", async (span) => {
      span.setAttribute("parent_job.id", options.parentJobId);
      span.setAttribute("revision.sha", options.revisionSha);

      const maxSamples = Math.min(20, Math.max(1, options.maxSamples ?? 5));
      const minSamples = Math.min(maxSamples, Math.max(1, options.minSamples ?? 1));
      const confidenceThreshold = options.confidenceThreshold ?? 0.90;
      const flakeRate = options.flakeRate ?? 0.10;
      const pollIntervalMs = options.pollIntervalMs ?? 100;
      const timeoutMs = options.timeoutMs ?? 60_000;
      const startTime = Date.now();

      // 1. Fan out independent sample jobs
      const scheduledJobIds: string[] = [];
      for (let i = 1; i <= maxSamples; i++) {
        const sampleJob = options.store.create(
          options.basePayload,
          new Date(),
          undefined,
          {
            type: "sample_evaluation",
            sampleMetadata: {
              parentJobId: options.parentJobId,
              sampleIndex: i,
              revisionSha: options.revisionSha,
              kind: "noisy_sample",
            },
            requiredCapabilities: {
              jobTypes: ["sample_evaluation"],
              ...(options.requiredCapabilities?.profile ? { profile: options.requiredCapabilities.profile } : {}),
              ...(options.requiredCapabilities?.features ? { features: options.requiredCapabilities.features } : {}),
              ...(options.requiredCapabilities?.environmentIdentity ? { environmentIdentity: options.requiredCapabilities.environmentIdentity } : {}),
            },
          }
        );
        scheduledJobIds.push(sampleJob.id);
      }

      let passes = 0;
      let fails = 0;
      let skips = 0;
      let earlyStopped = false;
      let decision: "good" | "bad" | "inconclusive" | "aborted" = "inconclusive";
      let explanation = "";
      const processedJobIds = new Set<string>();
      const acceptedSampleIds: string[] = [];

      try {
        while (Date.now() - startTime < timeoutMs) {
          if (options.abortSignal?.aborted) {
            decision = "aborted";
            explanation = "Batch sampling cancelled by abort signal";
            break;
          }

          const snapshot = options.store.list();
          let newResultFound = false;

          for (const jobId of scheduledJobIds) {
            if (processedJobIds.has(jobId)) continue;
            const job = snapshot.find((j) => j.id === jobId);
            if (!job) continue;

            if (job.state === "succeeded" && job.result?.sampleResult) {
              const res = job.result.sampleResult;
              // Guard: verify revision and attempt
              if (job.sampleMetadata?.revisionSha !== options.revisionSha) {
                defaultMetrics.staleResultsRejectedTotal.inc(1, { reason: "revision_mismatch" });
                continue;
              }

              processedJobIds.add(jobId);
              acceptedSampleIds.push(jobId);
              newResultFound = true;

              if (res.outcome === "good") passes++;
              else if (res.outcome === "bad") fails++;
              else skips++;

              // Check Bayesian decision
              const totalEvaluated = passes + fails;
              if (totalEvaluated >= minSamples) {
                const evalResult = evaluateBayesianDecision({
                  passes,
                  fails,
                  confidenceThreshold,
                  flakeRate,
                });

                if (evalResult.decision === "good" || evalResult.decision === "bad") {
                  decision = evalResult.decision;
                  earlyStopped = processedJobIds.size < maxSamples;
                  explanation = `Noisy oracle reached ${decision} (P(${decision})=${(decision === "bad" ? evalResult.posteriorBad : evalResult.posteriorGood).toFixed(4)} >= ${confidenceThreshold} after ${totalEvaluated} samples; ${passes} passed, ${fails} failed, ${skips} skipped)`;
                  break;
                }
              }
            } else if (job.state === "failed" || job.state === "cancelled") {
              processedJobIds.add(jobId);
              skips++;
              newResultFound = true;
            }
          }

          if (decision === "good" || decision === "bad") {
            break;
          }

          if (processedJobIds.size >= scheduledJobIds.length) {
            // All scheduled samples have completed without meeting threshold
            const evalResult = evaluateBayesianDecision({
              passes,
              fails,
              confidenceThreshold,
              flakeRate,
            });
            decision = "inconclusive";
            explanation = `Sampling budget exhausted (${maxSamples} samples; ${passes} passed, ${fails} failed, ${skips} skipped) without reaching confidence threshold ${confidenceThreshold} (P(bad)=${evalResult.posteriorBad.toFixed(4)})`;
            break;
          }

          if (!newResultFound) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
        }

        if (decision === "inconclusive" && !explanation) {
          explanation = `Sampling timed out after ${timeoutMs}ms (${passes} passed, ${fails} failed, ${skips} skipped)`;
        }
      } finally {
        // Cancel remaining uncompleted sample jobs (early stopping cleanup)
        for (const jobId of scheduledJobIds) {
          if (!processedJobIds.has(jobId)) {
            try {
              options.store.requestCancel(jobId, `Sample batch completed with decision ${decision}`);
            } catch {
              // Ignore already-finished jobs
            }
          }
        }
      }

      const evalResult = evaluateBayesianDecision({ passes, fails, confidenceThreshold, flakeRate });
      return {
        decision,
        revisionSha: options.revisionSha,
        passes,
        fails,
        skips,
        totalEvaluated: passes + fails,
        posteriorBad: evalResult.posteriorBad,
        posteriorGood: evalResult.posteriorGood,
        confidenceThreshold,
        sampleJobIds: scheduledJobIds,
        acceptedSampleIds,
        earlyStopped,
        explanation,
      };
    });
  }

  /**
   * Fans out parallel benchmark measurement jobs across workers sharing compatible
   * environment identity, collects raw measurements, and evaluates regression using Welch's t-test.
   */
  static async scheduleBenchmarkBatch(
    options: BenchmarkSamplingBatchOptions
  ): Promise<BenchmarkSamplingDecision> {
    const tracer = getTracer("bisectpilot.fleet");
    return tracer.withSpan("fleet.schedule_benchmark_batch", async (span) => {
      span.setAttribute("parent_job.id", options.parentJobId);
      span.setAttribute("baseline.sha", options.baselineSha);
      span.setAttribute("candidate.sha", options.candidateSha);

      const maxSamples = Math.min(20, Math.max(3, options.maxSamples ?? 5));
      const minSamples = Math.min(maxSamples, Math.max(3, options.minSamples ?? 3));
      const pollIntervalMs = options.pollIntervalMs ?? 100;
      const timeoutMs = options.timeoutMs ?? 60_000;
      const startTime = Date.now();

      const candidateJobIds: string[] = [];
      const baselineJobIds: string[] = [];

      // Fan out candidate benchmark jobs pinned to exact environmentIdentity
      for (let i = 1; i <= maxSamples; i++) {
        const candidateJob = options.store.create(
          options.basePayload,
          new Date(),
          undefined,
          {
            type: "benchmark_sample",
            sampleMetadata: {
              parentJobId: options.parentJobId,
              sampleIndex: i,
              revisionSha: options.candidateSha,
              kind: "benchmark_sample",
            },
            requiredCapabilities: {
              jobTypes: ["benchmark_sample"],
              environmentIdentity: options.environmentIdentity,
            },
          }
        );
        candidateJobIds.push(candidateJob.id);

        const baselineJob = options.store.create(
          options.basePayload,
          new Date(),
          undefined,
          {
            type: "benchmark_sample",
            sampleMetadata: {
              parentJobId: options.parentJobId,
              sampleIndex: i + 1000,
              revisionSha: options.baselineSha,
              kind: "benchmark_sample",
            },
            requiredCapabilities: {
              jobTypes: ["benchmark_sample"],
              environmentIdentity: options.environmentIdentity,
            },
          }
        );
        baselineJobIds.push(baselineJob.id);
      }

      const allJobIds = [...candidateJobIds, ...baselineJobIds];
      const candidateMeasurements: number[] = [];
      const baselineMeasurements: number[] = [];
      const processedJobIds = new Set<string>();
      let earlyStopped = false;
      let decision: "regression" | "non_regression" | "inconclusive" | "aborted" = "inconclusive";
      let explanation = "";
      let finalEval: BenchmarkEvaluationResult | undefined;

      try {
        while (Date.now() - startTime < timeoutMs) {
          if (options.abortSignal?.aborted) {
            decision = "aborted";
            explanation = "Benchmark sampling cancelled by abort signal";
            break;
          }

          const snapshot = options.store.list();
          let newResultFound = false;

          for (const job of snapshot) {
            if (!allJobIds.includes(job.id) || processedJobIds.has(job.id)) continue;

            if (job.state === "succeeded" && job.result?.sampleResult) {
              const res = job.result.sampleResult;
              if (typeof res.measurement === "number" && Number.isFinite(res.measurement)) {
                processedJobIds.add(job.id);
                newResultFound = true;

                if (job.sampleMetadata?.revisionSha === options.candidateSha) {
                  candidateMeasurements.push(res.measurement);
                } else if (job.sampleMetadata?.revisionSha === options.baselineSha) {
                  baselineMeasurements.push(res.measurement);
                }

                // Check if we have enough samples to evaluate
                if (candidateMeasurements.length >= minSamples && baselineMeasurements.length >= minSamples) {
                  const bStats = buildBenchmarkStats(baselineMeasurements, options.benchmarkSpec.metric, 0, options.benchmarkSpec.unit);
                  const cStats = buildBenchmarkStats(candidateMeasurements, options.benchmarkSpec.metric, 0, options.benchmarkSpec.unit);
                  const evalResult = evaluateBenchmarkRegression({
                    baseline: bStats,
                    candidate: cStats,
                    config: options.benchmarkSpec,
                  });

                  if (evalResult.decision === "regression" || evalResult.decision === "non_regression") {
                    decision = evalResult.decision;
                    finalEval = evalResult;
                    earlyStopped = processedJobIds.size < allJobIds.length;
                    explanation = evalResult.reason;
                    break;
                  }
                }
              }
            } else if (job.state === "failed" || job.state === "cancelled") {
              processedJobIds.add(job.id);
              newResultFound = true;
            }
          }

          if (decision === "regression" || decision === "non_regression") {
            break;
          }

          if (processedJobIds.size >= allJobIds.length) {
            if (candidateMeasurements.length >= 2 && baselineMeasurements.length >= 2) {
              const bStats = buildBenchmarkStats(baselineMeasurements, options.benchmarkSpec.metric, 0, options.benchmarkSpec.unit);
              const cStats = buildBenchmarkStats(candidateMeasurements, options.benchmarkSpec.metric, 0, options.benchmarkSpec.unit);
              finalEval = evaluateBenchmarkRegression({
                baseline: bStats,
                candidate: cStats,
                config: options.benchmarkSpec,
              });
              decision = finalEval.decision;
              explanation = finalEval.reason;
            } else {
              decision = "inconclusive";
              explanation = `Insufficient valid benchmark measurements collected (${baselineMeasurements.length} baseline, ${candidateMeasurements.length} candidate)`;
            }
            break;
          }

          if (!newResultFound) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
        }

        if (decision === "inconclusive" && !explanation) {
          explanation = `Benchmark sampling timed out after ${timeoutMs}ms`;
        }
      } finally {
        for (const jobId of allJobIds) {
          if (!processedJobIds.has(jobId)) {
            try {
              options.store.requestCancel(jobId, `Benchmark batch completed with decision ${decision}`);
            } catch {
              // Ignore already-finished jobs
            }
          }
        }
      }

      return {
        decision,
        explanation,
        baselineSha: options.baselineSha,
        candidateSha: options.candidateSha,
        baselineMeasurements,
        candidateMeasurements,
        evaluation: finalEval,
        sampleJobIds: allJobIds,
        earlyStopped,
      };
    });
  }

  /**
   * Safely cancels all outstanding sample jobs in a batch.
   */
  static cancelBatch(store: AtomicJobStore, jobIds: readonly string[], reason = "Batch cancelled"): void {
    for (const id of jobIds) {
      try {
        store.requestCancel(id, reason);
      } catch {
        // Safe to ignore non-existent or completed jobs
      }
    }
  }
}
