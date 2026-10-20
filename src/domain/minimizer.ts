import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type OracleOutcome,
} from "../contracts/index.js";
import { runSafeProcess, type ProcessRunResult } from "../adapters/process/process-runner.js";
import { classifyOracleStep, makeOutcome } from "./classification.js";

import { evaluateBayesianDecision } from "./bayesian.js";

export type MinimizerGranularity = "line" | "char" | "both";

export interface MinimizeConfig {
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly testCommand: string;
  readonly testArgs?: readonly string[];
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly maxEvaluations?: number;
  readonly granularity?: MinimizerGranularity;
  readonly noisy?: boolean;
  readonly noisyConfidence?: number;
  readonly noisyFlakeRate?: number;
  readonly noisyMaxSamples?: number;
  readonly abortSignal?: AbortSignal;
  readonly executionPolicy?: ExecutionPolicy;
  readonly overwriteOutput?: boolean;
  readonly customOracle?: (candidateContent: string, candidatePath: string) => Promise<OracleOutcome>;
  readonly onProgress?: (progress: MinimizeProgress) => void;
}

export interface MinimizeProgress {
  readonly evaluationCount: number;
  readonly currentSize: number;
  readonly originalSize: number;
  readonly subsetsCount: number;
  readonly stage: "baseline" | "minimizing" | "completed" | "failed";
  readonly lastOutcome?: OracleOutcome;
}

export interface InputSize {
  readonly lines: number;
  readonly bytes: number;
}

export type MinimizerStoppedReason =
  | "minimal"
  | "budget_exhausted"
  | "cancelled"
  | "timeout"
  | "baseline_failed"
  | "error";

export interface MinimizeResult {
  readonly success: boolean;
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly originalInput: string;
  readonly minimizedInput: string;
  readonly originalSize: InputSize;
  readonly minimizedSize: InputSize;
  readonly reductionRatio: number;
  readonly evaluationCount: number;
  readonly baselineOutcome: OracleOutcome;
  readonly finalOutcome: OracleOutcome;
  readonly stoppedReason: MinimizerStoppedReason;
  readonly detail: string;
}

export interface MinimizationReportJson {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly originalSize: InputSize;
  readonly minimizedSize: InputSize;
  readonly reductionPercentage: number;
  readonly evaluationCount: number;
  readonly stoppedReason: MinimizerStoppedReason;
  readonly baselineOutcome: OracleOutcome;
  readonly finalOutcome: OracleOutcome;
  readonly detail: string;
}

export function computeSize(text: string): InputSize {
  if (text.length === 0) return { lines: 0, bytes: 0 };
  const raw = text.split("\n");
  const lines = text.endsWith("\n") && raw[raw.length - 1] === "" ? raw.length - 1 : raw.length;
  const bytes = Buffer.byteLength(text, "utf-8");
  return { lines, bytes };
}


function partition<T>(items: readonly T[], n: number): T[][] {
  const count = Math.max(1, Math.min(n, items.length));
  const chunks: T[][] = [];
  const chunkSize = Math.ceil(items.length / count);
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function complementOf<T>(chunks: readonly (readonly T[])[], excludeIndex: number): T[] {
  const result: T[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i !== excludeIndex) {
      result.push(...chunks[i]!);
    }
  }
  return result;
}

function splitLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  const hasTrailingNewline = text.endsWith("\n");
  const raw = text.split("\n");
  if (hasTrailingNewline && raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return { lines: raw, hasTrailingNewline };
}

function joinLines(lines: readonly string[], hasTrailingNewline: boolean): string {
  const joined = lines.join("\n");
  return hasTrailingNewline && lines.length > 0 ? joined + "\n" : joined;
}

/**
 * Validates input and output paths to ensure safety and prevent directory traversal.
 */
export function validateMinimizerPaths(inputPath: string, outputPath?: string, overwrite = false): {
  resolvedInput: string;
  resolvedOutput?: string;
} {
  const resolvedInput = path.resolve(inputPath);
  if (!existsSync(resolvedInput)) {
    throw new Error(`Input file does not exist: ${resolvedInput}`);
  }
  const stat = statSync(resolvedInput);
  if (!stat.isFile()) {
    throw new Error(`Input path is not a regular file: ${resolvedInput}`);
  }

  let resolvedOutput: string | undefined;
  if (outputPath) {
    resolvedOutput = path.resolve(outputPath);
    if (resolvedOutput === resolvedInput && !overwrite) {
      throw new Error(`Output path cannot overwrite input file without explicit authorization: ${resolvedOutput}`);
    }
    const outDir = path.dirname(resolvedOutput);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
  }

  return { resolvedInput, resolvedOutput };
}

/**
 * Evaluates a candidate input using either a custom oracle or via ProcessRunner in an isolated directory.
 */
export async function evaluateCandidateInput(
  candidateContent: string,
  config: MinimizeConfig,
  resolvedInputPath: string,
  timeoutMs: number
): Promise<OracleOutcome> {
  const baseName = path.basename(resolvedInputPath);

  // If a custom programmatic oracle is provided, invoke it directly
  if (config.customOracle) {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-min-"));
    const candidatePath = path.join(tempDir, baseName);
    try {
      writeFileSync(candidatePath, candidateContent, "utf-8");
      return await config.customOracle(candidateContent, candidatePath);
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Safe cleanup
      }
    }
  }

  // Create isolated temp workspace for execution
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "bisectpilot-min-"));
  const candidatePath = path.join(tempDir, baseName);
  writeFileSync(candidatePath, candidateContent, "utf-8");

  try {
    const rawArgs = config.testArgs ?? [];
    const expandedArgs = rawArgs.some((a) => a.includes("{input}") || a.includes("<input>"))
      ? rawArgs.map((a) => a.replace(/\{input\}/g, candidatePath).replace(/<input>/g, candidatePath))
      : [...rawArgs, candidatePath];

    const runCandidateOnce = async (): Promise<ProcessRunResult> => {
      const executionPolicy = config.executionPolicy ?? DEFAULT_EXECUTION_POLICY;
      return runSafeProcess({
        commandSpec: {
          command: config.testCommand,
          args: expandedArgs,
          timeoutMs,
        },
        cwd: config.workingDirectory ?? tempDir,
        executionPolicy,
        ...(executionPolicy.sandbox
          ? {
              workspaceRoot: tempDir,
              sandboxAllowedReadOnlyRoots: [tempDir],
              sandboxOwnerId: `minimizer-${process.pid}`,
            }
          : {}),
        abortSignal: config.abortSignal,
      });
    };


    if (config.noisy) {
      const maxSamples = config.noisyMaxSamples ?? 5;
      const confidenceThreshold = config.noisyConfidence ?? 0.9;
      const flakeRate = config.noisyFlakeRate ?? 0.1;
      let passes = 0;
      let fails = 0;
      let skips = 0;
      let lastResult: ProcessRunResult | undefined;

      for (let i = 0; i < maxSamples; i++) {
        if (config.abortSignal?.aborted) {
          return makeOutcome("abort", "cancelled", "Minimization cancelled by signal during noisy evaluation");
        }
        const runRes = await runCandidateOnce();
        lastResult = runRes;
        const outcome = classifyOracleStep(runRes, "functional");

        if (outcome.kind === "good") passes++;
        else if (outcome.kind === "bad") fails++;
        else skips++;

        const decision = evaluateBayesianDecision({
          passes,
          fails,
          flakeRate,
          confidenceThreshold,
        });

        if (decision.decision === "bad") {
          return makeOutcome(
            "bad",
            "oracle_failed_expected_regression",
            `Noisy oracle confirmed failure with posterior ${(decision.posteriorBad * 100).toFixed(1)}% (${fails} fails, ${passes} passes)`,
            "automated",
            {
              sampleCount: i + 1,
              passedRuns: passes,
              failedRuns: fails,
              skippedRuns: skips,
              posterior: decision.posteriorBad,
              confidenceThreshold,
            }
          );
        }

        if (decision.decision === "good") {
          return makeOutcome(
            "good",
            "oracle_passed",
            `Noisy oracle confirmed pass with posterior ${(decision.posteriorGood * 100).toFixed(1)}% (${passes} passes, ${fails} fails)`,
            "automated",
            {
              sampleCount: i + 1,
              passedRuns: passes,
              failedRuns: fails,
              skippedRuns: skips,
              posterior: decision.posteriorBad,
              confidenceThreshold,
            }
          );
        }
      }

      // If confidence not reached within sample budget, treat as inconclusive skip
      return makeOutcome(
        "skip",
        "build_prerequisite_failed",
        `Noisy oracle inconclusive after ${maxSamples} samples (${fails} fails, ${passes} passes, ${skips} skips)`
      );
    }

    const res = await runCandidateOnce();
    return classifyOracleStep(res, "functional");
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Safe cleanup
    }
  }
}

/**
 * Standard Delta Debugging (ddmin) algorithm on elements.
 */
async function ddminCore<T>(
  items: readonly T[],
  evaluateFn: (candidate: readonly T[]) => Promise<{ outcome: OracleOutcome; isBad: boolean }>,
  options: {
    maxEvaluations: number;
    abortSignal?: AbortSignal;
    onProgress?: (progress: MinimizeProgress) => void;
    currentEvaluations: number;
    originalSize: number;
  }
): Promise<{
  minimalItems: T[];
  stoppedReason: MinimizerStoppedReason;
  evaluations: number;
  lastOutcome: OracleOutcome;
}> {
  let n = 2;
  let current = [...items];
  let evals = options.currentEvaluations;
  let lastOutcome: OracleOutcome = makeOutcome("bad", "oracle_failed_expected_regression", "initial");

  while (current.length > 1) {
    if (options.abortSignal?.aborted) {
      return { minimalItems: current, stoppedReason: "cancelled", evaluations: evals, lastOutcome };
    }
    if (evals >= options.maxEvaluations) {
      return { minimalItems: current, stoppedReason: "budget_exhausted", evaluations: evals, lastOutcome };
    }

    const subsets = partition(current, n);
    let reductionFound = false;

    // 1. Try subsets
    for (const subset of subsets) {
      if (subset.length === 0 || subset.length === current.length) continue;
      if (evals >= options.maxEvaluations || options.abortSignal?.aborted) break;

      evals++;
      const res = await evaluateFn(subset);
      lastOutcome = res.outcome;
      options.onProgress?.({
        evaluationCount: evals,
        currentSize: subset.length,
        originalSize: options.originalSize,
        subsetsCount: n,
        stage: "minimizing",
        lastOutcome,
      });

      if (res.isBad) {
        current = subset;
        n = 2;
        reductionFound = true;
        break;
      }
    }

    if (reductionFound) {
      continue;
    }

    // 2. Try complements (for n > 2)
    if (n > 2) {
      for (let i = 0; i < subsets.length; i++) {
        const complement = complementOf(subsets, i);
        if (complement.length === 0 || complement.length === current.length) continue;
        if (evals >= options.maxEvaluations || options.abortSignal?.aborted) break;

        evals++;
        const res = await evaluateFn(complement);
        lastOutcome = res.outcome;
        options.onProgress?.({
          evaluationCount: evals,
          currentSize: complement.length,
          originalSize: options.originalSize,
          subsetsCount: n,
          stage: "minimizing",
          lastOutcome,
        });

        if (res.isBad) {
          current = complement;
          n = Math.max(n - 1, 2);
          reductionFound = true;
          break;
        }
      }
    }

    if (reductionFound) {
      continue;
    }

    // 3. Increase granularity
    if (n < current.length) {
      n = Math.min(current.length, n * 2);
    } else {
      // 1-minimal elements reached
      return { minimalItems: current, stoppedReason: "minimal", evaluations: evals, lastOutcome };
    }
  }

  return { minimalItems: current, stoppedReason: "minimal", evaluations: evals, lastOutcome };
}

/**
 * Main Delta Debugging Minimizer for BisectPilot.
 */
export async function minimizeInput(config: MinimizeConfig): Promise<MinimizeResult> {
  const { resolvedInput, resolvedOutput } = validateMinimizerPaths(
    config.inputPath,
    config.outputPath,
    config.overwriteOutput
  );

  const originalInput = readFileSync(resolvedInput, "utf-8");
  const originalSize = computeSize(originalInput);
  const maxEvaluations = config.maxEvaluations ?? 300;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const granularity = config.granularity ?? "line";

  // Step 1: Establish baseline with original input
  const baselineOutcome = await evaluateCandidateInput(
    originalInput,
    config,
    resolvedInput,
    timeoutMs
  );

  if (baselineOutcome.kind !== "bad") {
    return {
      success: false,
      inputPath: resolvedInput,
      outputPath: resolvedOutput,
      originalInput,
      minimizedInput: originalInput,
      originalSize,
      minimizedSize: originalSize,
      reductionRatio: 0,
      evaluationCount: 1,
      baselineOutcome,
      finalOutcome: baselineOutcome,
      stoppedReason: "baseline_failed",
      detail: `Baseline test did not reproduce target failure (outcome: ${baselineOutcome.kind}, reason: ${baselineOutcome.reasonCode}). Minimization stopped to prevent false reduction.`,
    };
  }

  let currentText = originalInput;
  let totalEvaluations = 1;
  let lastOutcome = baselineOutcome;
  let stoppedReason: MinimizerStoppedReason = "minimal";

  // Phase A: Line-level minimization
  if (granularity === "line" || granularity === "both") {
    const { lines, hasTrailingNewline } = splitLines(currentText);

    if (lines.length > 1) {
      const evaluateLines = async (candidateLines: readonly string[]) => {
        const text = joinLines(candidateLines, hasTrailingNewline);
        const outcome = await evaluateCandidateInput(text, config, resolvedInput, timeoutMs);
        return { outcome, isBad: outcome.kind === "bad" };
      };

      const lineResult = await ddminCore(lines, evaluateLines, {
        maxEvaluations,
        abortSignal: config.abortSignal,
        onProgress: config.onProgress,
        currentEvaluations: totalEvaluations,
        originalSize: lines.length,
      });

      totalEvaluations = lineResult.evaluations;
      lastOutcome = lineResult.lastOutcome;
      stoppedReason = lineResult.stoppedReason;
      currentText = joinLines(lineResult.minimalItems, hasTrailingNewline);
    }
  }

  // Phase B: Character-level minimization (if requested or if "both" and line-level finished)
  if (
    (granularity === "char" || (granularity === "both" && stoppedReason === "minimal")) &&
    currentText.length > 1 &&
    totalEvaluations < maxEvaluations &&
    !config.abortSignal?.aborted
  ) {
    const chars = currentText.split("");
    const evaluateChars = async (candidateChars: readonly string[]) => {
      const text = candidateChars.join("");
      const outcome = await evaluateCandidateInput(text, config, resolvedInput, timeoutMs);
      return { outcome, isBad: outcome.kind === "bad" };
    };

    const charResult = await ddminCore(chars, evaluateChars, {
      maxEvaluations,
      abortSignal: config.abortSignal,
      onProgress: config.onProgress,
      currentEvaluations: totalEvaluations,
      originalSize: chars.length,
    });

    totalEvaluations = charResult.evaluations;
    lastOutcome = charResult.lastOutcome;
    if (charResult.stoppedReason !== "minimal") {
      stoppedReason = charResult.stoppedReason;
    }
    currentText = charResult.minimalItems.join("");
  }

  const minimizedSize = computeSize(currentText);
  const reductionRatio =
    originalSize.bytes > 0
      ? Math.max(0, (originalSize.bytes - minimizedSize.bytes) / originalSize.bytes)
      : 0;

  // Persist output if path specified
  if (resolvedOutput) {
    writeFileSync(resolvedOutput, currentText, "utf-8");
  }

  const detail =
    reductionRatio > 0
      ? `Reduced input from ${originalSize.lines} lines (${originalSize.bytes} B) to ${minimizedSize.lines} lines (${minimizedSize.bytes} B), ${(reductionRatio * 100).toFixed(1)}% reduction across ${totalEvaluations} evaluations.`
      : `Input is already minimal or could not be reduced further; verified in ${totalEvaluations} evaluations.`;

  return {
    success: true,
    inputPath: resolvedInput,
    outputPath: resolvedOutput,
    originalInput,
    minimizedInput: currentText,
    originalSize,
    minimizedSize,
    reductionRatio,
    evaluationCount: totalEvaluations,
    baselineOutcome,
    finalOutcome: lastOutcome,
    stoppedReason,
    detail,
  };
}

/**
 * Formats a minimization result as JSON.
 */
export function formatMinimizationReportJson(result: MinimizeResult): MinimizationReportJson {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    inputPath: result.inputPath,
    outputPath: result.outputPath,
    originalSize: result.originalSize,
    minimizedSize: result.minimizedSize,
    reductionPercentage: Math.round(result.reductionRatio * 1000) / 10,
    evaluationCount: result.evaluationCount,
    stoppedReason: result.stoppedReason,
    baselineOutcome: result.baselineOutcome,
    finalOutcome: result.finalOutcome,
    detail: result.detail,
  };
}

/**
 * Formats a minimization result as human-readable markdown.
 */
export function formatMinimizationReportMarkdown(result: MinimizeResult): string {
  const pct = (result.reductionRatio * 100).toFixed(1);
  return `# BisectPilot Input Minimization Report

- **Input:** \`${result.inputPath}\`
- **Output:** ${result.outputPath ? `\`${result.outputPath}\`` : "None (in-memory)"}
- **Status:** ${result.success ? "Success" : "Failed"} (${result.stoppedReason})
- **Original Size:** ${result.originalSize.lines} lines (${result.originalSize.bytes} bytes)
- **Minimized Size:** ${result.minimizedSize.lines} lines (${result.minimizedSize.bytes} bytes)
- **Reduction Achieved:** **${pct}%**
- **Oracle Evaluations:** ${result.evaluationCount}
- **Baseline Classification:** ${result.baselineOutcome.kind} (${result.baselineOutcome.reasonCode})
- **Final Classification:** ${result.finalOutcome.kind} (${result.finalOutcome.reasonCode})

## Detail
${result.detail}

## Minimized Content
\`\`\`
${result.minimizedInput}
\`\`\`
`;
}
