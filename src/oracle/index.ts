import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  BisectConfigV1,
  CommandSpec,
  LedgerEvent,
  OracleOutcome,
  StepPhase,
} from "../contracts/index.js";
import {
  classifyBuildStep,
  classifyOracleStep,
  classifyPrepareStep,
  makeOutcome,
} from "../domain/classification.js";
import { evaluateBayesianDecision } from "../domain/bayesian.js";
import { runGit } from "../git/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import { applyToolchainWrapper, runSafeProcess, type ProcessRunResult } from "../process/index.js";
import { redactSensitiveText } from "../reports/index.js";

export interface ToolchainInspection {
  readonly detectedNodeSpec?: string;
  readonly requiredMajor?: number;
  readonly runningNodeVersion: string;
  readonly runningMajor: number;
  readonly packageManager?: string;
  readonly mismatch: boolean;
}

function parseMajorVersion(spec: string): number | undefined {
  const cleaned = spec.trim().replace(/^[v^~>=<\s]+/, "");
  const match = /^(\d+)/.exec(cleaned);
  return match ? Number(match[1]) : undefined;
}

/**
 * Per-revision Node.js toolchain inspection (Section 26.9). Reads files only; never executes scripts.
 */
export function inspectRevisionToolchain(worktreePath: string): ToolchainInspection {
  const runningNodeVersion = process.versions.node;
  const runningMajor = Number(runningNodeVersion.split(".")[0] ?? "0");
  let detectedNodeSpec: string | undefined;
  let packageManager: string | undefined;

  const nvmrcPath = path.join(worktreePath, ".nvmrc");
  const nodeVersionPath = path.join(worktreePath, ".node-version");
  const pkgJsonPath = path.join(worktreePath, "package.json");

  if (existsSync(nvmrcPath)) {
    detectedNodeSpec = readFileSync(nvmrcPath, "utf-8").trim();
  } else if (existsSync(nodeVersionPath)) {
    detectedNodeSpec = readFileSync(nodeVersionPath, "utf-8").trim();
  }

  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        engines?: { node?: string };
        packageManager?: string;
      };
      if (!detectedNodeSpec && typeof pkg.engines?.node === "string") {
        detectedNodeSpec = pkg.engines.node;
      }
      if (typeof pkg.packageManager === "string") {
        packageManager = pkg.packageManager;
      }
    } catch {
      // Ignore malformed historical package.json
    }
  }

  const requiredMajor = detectedNodeSpec ? parseMajorVersion(detectedNodeSpec) : undefined;
  const mismatch =
    requiredMajor !== undefined &&
    !detectedNodeSpec?.includes(">=") &&
    requiredMajor !== runningMajor;

  return {
    ...(detectedNodeSpec ? { detectedNodeSpec } : {}),
    ...(requiredMajor !== undefined ? { requiredMajor } : {}),
    runningNodeVersion,
    runningMajor,
    ...(packageManager ? { packageManager } : {}),
    mismatch,
  };
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function snapshotOverlayFiles(
  repoRoot: string,
  sessionDir: string,
  overlayFiles: readonly string[]
): Record<string, string> {
  const snapshotDir = path.join(sessionDir, "overlays");
  mkdirSync(snapshotDir, { recursive: true });
  const hashes: Record<string, string> = {};

  for (const relPath of overlayFiles) {
    const normalizedRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const sourcePath = path.resolve(repoRoot, normalizedRel);
    if (!existsSync(sourcePath)) {
      throw new Error(`Overlay file not found at ${sourcePath}`);
    }
    const destPath = path.resolve(snapshotDir, normalizedRel);
    mkdirSync(path.dirname(destPath), { recursive: true });
    copyFileSync(sourcePath, destPath);
    hashes[normalizedRel] = sha256File(destPath);
  }
  return hashes;
}

export function snapshotExternalScript(
  repoRoot: string,
  sessionDir: string,
  externalScriptPath: string
): { readonly snapshotPath: string; readonly sha256: string } {
  const sourcePath = path.resolve(repoRoot, externalScriptPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`External oracle script not found at ${sourcePath}`);
  }
  const externalDir = path.join(sessionDir, "external");
  mkdirSync(externalDir, { recursive: true });
  const destPath = path.join(externalDir, path.basename(sourcePath));
  copyFileSync(sourcePath, destPath);
  return { snapshotPath: destPath, sha256: sha256File(destPath) };
}

export async function isPathTrackedInRevision(
  worktreePath: string,
  relPath: string
): Promise<boolean> {
  const res = await runGit(["ls-files", "--error-unmatch", "--", relPath], worktreePath);
  return res.exitCode === 0;
}

export { applyToolchainWrapper as wrapCommandWithToolchain };

export interface PromptStreams {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
}

export async function promptHumanClassification(params: {
  readonly commitSha: string;
  readonly commandSpec: CommandSpec;
  readonly automatedOutcome: OracleOutcome;
  readonly capturedOutput?: { readonly stdout: string; readonly stderr: string };
  readonly executionInfo?: string;
  readonly streams?: PromptStreams;
  readonly abortSignal?: AbortSignal;
}): Promise<OracleOutcome> {
  const input = params.streams?.input ?? process.stdin;
  const output = params.streams?.output ?? process.stdout;
  const isInteractive =
    params.streams?.isTTY !== undefined
      ? params.streams.isTTY
      : params.streams?.input !== undefined
        ? Boolean((input as any).isTTY ?? true)
        : Boolean(process.stdin.isTTY);

  if (params.abortSignal?.aborted) {
    return makeOutcome("abort", "cancelled", "Cancelled while awaiting interactive prompt");
  }

  if (!isInteractive) {
    output.write(
      `[prompt] Stdin is non-interactive; accepting automated outcome (${params.automatedOutcome.kind}: ${params.automatedOutcome.reasonCode})\n`
    );
    return params.automatedOutcome;
  }

  const redactedStdout = redactSensitiveText(params.capturedOutput?.stdout ?? "");
  const redactedStderr = redactSensitiveText(params.capturedOutput?.stderr ?? "");
  const combinedOutput = [
    redactedStdout ? `--- stdout ---\n${redactedStdout.trim()}` : "",
    redactedStderr ? `--- stderr ---\n${redactedStderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const promptMessage = [
    `\n=== BisectPilot Interactive Oracle Prompt ===`,
    `Commit:    ${params.commitSha.slice(0, 8)} (${params.commitSha})`,
    `Command:   ${params.commandSpec.command} ${params.commandSpec.args.join(" ")}`,
    `Outcome:   ${params.automatedOutcome.kind} (${params.automatedOutcome.reasonCode}): ${redactSensitiveText(params.automatedOutcome.detail)}`,
    params.executionInfo ? `Info:      ${redactSensitiveText(params.executionInfo)}` : "",
    combinedOutput ? `\nCaptured Output:\n${combinedOutput}\n` : "",
  ]
    .filter(Boolean)
    .join("\n");

  output.write(`${promptMessage}\n`);

  return new Promise<OracleOutcome>((resolve) => {
    let resolved = false;
    const rl = readline.createInterface({
      input,
      output,
      terminal: false,
    });

    const finish = (outcome: OracleOutcome) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(outcome);
    };

    const onAbort = () => {
      finish(makeOutcome("abort", "cancelled", "Cancelled while awaiting interactive prompt"));
    };

    if (params.abortSignal) {
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const ask = () => {
      rl.question("Classify this revision as (g)ood, (b)ad, or (s)kip? ", (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "g" || trimmed === "good") {
          finish(
            makeOutcome(
              "good",
              "oracle_passed",
              `Classified as good by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else if (trimmed === "b" || trimmed === "bad") {
          finish(
            makeOutcome(
              "bad",
              params.automatedOutcome.kind === "bad"
                ? params.automatedOutcome.reasonCode
                : "oracle_failed_expected_regression",
              `Classified as bad by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else if (trimmed === "s" || trimmed === "skip") {
          finish(
            makeOutcome(
              "skip",
              params.automatedOutcome.kind === "skip"
                ? params.automatedOutcome.reasonCode
                : "build_prerequisite_failed",
              `Classified as skip by human operator (was ${params.automatedOutcome.kind})`,
              "human"
            )
          );
        } else {
          output.write(`Invalid choice "${answer.trim()}". Please enter 'g' for good, 'b' for bad, or 's' for skip.\n`);
          ask();
        }
      });
    };

    rl.once("close", () => {
      if (!resolved) {
        finish(params.automatedOutcome);
      }
    });

    ask();
  });
}

export interface RevisionEvaluationParams {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly ledgerPath: string;
  readonly worktreePath: string;
  readonly commitSha: string;
  readonly config: BisectConfigV1;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly phasePrefix?: "oracle" | "preflight_good" | "preflight_bad" | "boundary_check";
  readonly promptStreams?: PromptStreams;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
}

async function runAndRecordStep(params: {
  readonly sessionId: string;
  readonly ledgerPath: string;
  readonly commitSha: string;
  readonly phase: StepPhase;
  readonly commandSpec: CommandSpec;
  readonly cwd: string;
  readonly config: BisectConfigV1;
  readonly detectedToolchainVersion?: string;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
}): Promise<ProcessRunResult> {
  const wrapped = applyToolchainWrapper(
    params.commandSpec,
    params.config.execution.toolchainWrapper,
    params.detectedToolchainVersion
  );

  appendLedgerEvent(
    params.ledgerPath,
    {
      type: "process_starting",
      sessionId: params.sessionId,
      commitSha: params.commitSha,
      phase: params.phase,
      command: wrapped.command,
      args: wrapped.args,
      cwd: params.cwd,
    },
    params.onEvent
  );

  const result = await runSafeProcess({
    commandSpec: params.commandSpec,
    cwd: params.cwd,
    executionPolicy: params.config.execution,
    detectedToolchainVersion: params.detectedToolchainVersion,
    abortSignal: params.abortSignal,
  });

  appendLedgerEvent(
    params.ledgerPath,
    {
      type: "process_exited",
      sessionId: params.sessionId,
      commitSha: params.commitSha,
      phase: params.phase,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncatedStdout: result.truncatedStdout,
      truncatedStderr: result.truncatedStderr,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
      stdoutPreview: result.stdout.slice(0, 512),
      stderrPreview: result.stderr.slice(0, 512),
    },
    params.onEvent
  );

  return result;
}

/**
 * Evaluates a single checked-out revision in the tool-owned worktree (A4 + A5 + A6).
 * Guarantees overlay file removal in a `finally` block even on timeout or crash.
 */
export async function evaluateCheckedOutRevision(
  params: RevisionEvaluationParams
): Promise<OracleOutcome> {
  const stepCwd = path.resolve(params.worktreePath, params.config.workingDirectory || ".");
  const toolchain = inspectRevisionToolchain(params.worktreePath);
  const detectedVersion =
    toolchain.detectedNodeSpec ??
    (toolchain.requiredMajor !== undefined ? String(toolchain.requiredMajor) : undefined);
  const wrapper = params.config.execution.toolchainWrapper;

  if (wrapper) {
    const rawArgs = wrapper.args ?? [];
    const requiresVersion = rawArgs.some(
      (arg) => arg.includes("<version>") || arg.includes("${version}")
    );
    if (requiresVersion && !detectedVersion) {
      let outcome = makeOutcome(
        "skip",
        "toolchain_mismatch",
        `Toolchain wrapper (${wrapper.command}) requires a detected runtime version (<version>), but none was found in the revision`
      );
      if (
        params.config.execution.interactivePrompt === true &&
        (params.phasePrefix === "oracle" || params.phasePrefix === undefined)
      ) {
        outcome = await promptHumanClassification({
          commitSha: params.commitSha,
          commandSpec: params.config.oracle.command,
          automatedOutcome: outcome,
          executionInfo: `Toolchain wrapper requires version but none found in revision`,
          streams: params.promptStreams,
          abortSignal: params.abortSignal,
        });
      }
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "revision_classified",
          sessionId: params.sessionId,
          commitSha: params.commitSha,
          classification: outcome.kind,
          reasonCode: outcome.reasonCode,
          detail: outcome.detail,
          gitExitCode: outcome.gitExitCode,
          overlayHashes: params.overlayHashes,
          classifiedBy: outcome.classifiedBy ?? "automated",
          toolchainInfo: {
            ...(toolchain.detectedNodeSpec ? { detectedNodeSpec: toolchain.detectedNodeSpec } : {}),
            runningNodeVersion: toolchain.runningNodeVersion,
            ...(toolchain.packageManager ? { packageManager: toolchain.packageManager } : {}),
          },
        },
        params.onEvent
      );
      return outcome;
    }
  } else if (params.config.execution.enforceNodeToolchainCheck !== false && toolchain.mismatch) {
    let outcome = makeOutcome(
      "skip",
      "toolchain_mismatch",
      `Revision requires Node ${toolchain.detectedNodeSpec} (major ${toolchain.requiredMajor}), running ${toolchain.runningNodeVersion}`
    );
    if (
      params.config.execution.interactivePrompt === true &&
      (params.phasePrefix === "oracle" || params.phasePrefix === undefined)
    ) {
      outcome = await promptHumanClassification({
        commitSha: params.commitSha,
        commandSpec: params.config.oracle.command,
        automatedOutcome: outcome,
        executionInfo: `Toolchain mismatch: requires Node ${toolchain.detectedNodeSpec}, running ${toolchain.runningNodeVersion}`,
        streams: params.promptStreams,
        abortSignal: params.abortSignal,
      });
    }
    appendLedgerEvent(
      params.ledgerPath,
      {
        type: "revision_classified",
        sessionId: params.sessionId,
        commitSha: params.commitSha,
        classification: outcome.kind,
        reasonCode: outcome.reasonCode,
        detail: outcome.detail,
        gitExitCode: outcome.gitExitCode,
        overlayHashes: params.overlayHashes,
        classifiedBy: outcome.classifiedBy ?? "automated",
        toolchainInfo: {
          ...(toolchain.detectedNodeSpec ? { detectedNodeSpec: toolchain.detectedNodeSpec } : {}),
          runningNodeVersion: toolchain.runningNodeVersion,
          ...(toolchain.packageManager ? { packageManager: toolchain.packageManager } : {}),
        },
      },
      params.onEvent
    );
    return outcome;
  }

  const copiedOverlayTargets: string[] = [];
  let finalOutcome: OracleOutcome | undefined;

  try {
    if (params.config.oracle.mode === "overlay") {
      const overlayFiles = params.config.oracle.overlayFiles ?? [];
      const snapshotDir = path.join(params.sessionDir, "overlays");

      for (const relPath of overlayFiles) {
        const normalizedRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
        const snapFile = path.resolve(snapshotDir, normalizedRel);
        if (!existsSync(snapFile)) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Missing snapshotted overlay file: ${snapFile}`
          );
          return finalOutcome;
        }
        const actualHash = sha256File(snapFile);
        const expectedHash = params.overlayHashes[normalizedRel];
        if (expectedHash && actualHash !== expectedHash) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Overlay SHA-256 mismatch for ${normalizedRel}`
          );
          return finalOutcome;
        }

        if (await isPathTrackedInRevision(params.worktreePath, normalizedRel)) {
          const policy = params.config.oracle.overlayConflictPolicy ?? "skip";
          finalOutcome = makeOutcome(
            policy,
            "overlay_conflicts_with_tracked_file",
            `Overlay file "${normalizedRel}" conflicts with a tracked file at commit ${params.commitSha.slice(0, 8)}`
          );
          return finalOutcome;
        }

        const destPath = path.resolve(params.worktreePath, normalizedRel);
        mkdirSync(path.dirname(destPath), { recursive: true });
        copyFileSync(snapFile, destPath);
        copiedOverlayTargets.push(destPath);
      }
    }

    let lastRunResult: ProcessRunResult | undefined;

    if (params.config.prepare) {
      const prepRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "prepare",
        commandSpec: params.config.prepare,
        cwd: stepCwd,
        config: params.config,
        detectedToolchainVersion: detectedVersion,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
      });
      lastRunResult = prepRes;
      const prepClassification = classifyPrepareStep(prepRes);
      if (prepClassification) {
        finalOutcome = prepClassification;
      }
    }

    if (!finalOutcome && params.config.build) {
      const buildRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "build",
        commandSpec: params.config.build,
        cwd: stepCwd,
        config: params.config,
        detectedToolchainVersion: detectedVersion,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
      });
      lastRunResult = buildRes;
      const buildClassification = classifyBuildStep(
        buildRes,
        params.config.profile,
        params.config.build
      );
      if (buildClassification) {
        finalOutcome = buildClassification;
      }
    }

    const oraclePhase: StepPhase = params.phasePrefix ?? "oracle";
    let oracleCommandSpec = params.config.oracle.command;

    if (!finalOutcome) {
      if (params.config.oracle.mode === "external" && params.config.oracle.externalScriptPath) {
        const extSnap = path.join(
          params.sessionDir,
          "external",
          path.basename(params.config.oracle.externalScriptPath)
        );
        if (!existsSync(extSnap)) {
          finalOutcome = makeOutcome(
            "abort",
            "overlay_missing_or_corrupt",
            `Missing snapshotted external script: ${extSnap}`
          );
          return finalOutcome;
        }
        const rawExt = params.config.oracle.externalScriptPath;
        oracleCommandSpec = {
          ...oracleCommandSpec,
          command: oracleCommandSpec.command === rawExt ? extSnap : oracleCommandSpec.command,
          args: oracleCommandSpec.args.map((arg) => (arg === rawExt ? extSnap : arg)),
        };
      }

      const noisyPolicy = params.config.execution.noisyOracle;
      if (noisyPolicy?.enabled) {
        const maxSamples = noisyPolicy.maxSamplesPerRevision ?? 5;
        const confidenceThreshold = noisyPolicy.confidenceThreshold ?? 0.90;
        const flakeRate = noisyPolicy.flakeRate ?? 0.10;

        let passedRuns = 0;
        let failedRuns = 0;
        let skippedRuns = 0;

        for (let sample = 1; sample <= maxSamples; sample++) {
          if (params.abortSignal?.aborted) {
            finalOutcome = makeOutcome("abort", "cancelled", "Cancelled during noisy oracle sampling");
            break;
          }

          const oracleRes = await runAndRecordStep({
            sessionId: params.sessionId,
            ledgerPath: params.ledgerPath,
            commitSha: params.commitSha,
            phase: oraclePhase,
            commandSpec: oracleCommandSpec,
            cwd: stepCwd,
            config: params.config,
            detectedToolchainVersion: detectedVersion,
            abortSignal: params.abortSignal,
            onEvent: params.onEvent,
          });
          lastRunResult = oracleRes;

          const sampleOutcome = classifyOracleStep(oracleRes, params.config.profile);
          if (sampleOutcome.kind === "abort") {
            finalOutcome = sampleOutcome;
            break;
          } else if (sampleOutcome.kind === "good") {
            passedRuns++;
          } else if (sampleOutcome.kind === "bad") {
            failedRuns++;
          } else {
            skippedRuns++;
          }

          const evalResult = evaluateBayesianDecision({
            passes: passedRuns,
            fails: failedRuns,
            confidenceThreshold,
            flakeRate,
          });

          if (evalResult.decision === "bad") {
            finalOutcome = makeOutcome(
              "bad",
              "oracle_failed_expected_regression",
              `Noisy oracle classified revision as bad (P(bad)=${evalResult.posteriorBad.toFixed(4)} >= ${confidenceThreshold} after ${sample} samples; ${failedRuns} failed, ${passedRuns} passed)`,
              "automated",
              {
                sampleCount: sample,
                passedRuns,
                failedRuns,
                skippedRuns,
                posterior: evalResult.posteriorBad,
                confidenceThreshold,
              }
            );
            break;
          } else if (evalResult.decision === "good") {
            finalOutcome = makeOutcome(
              "good",
              "oracle_passed",
              `Noisy oracle classified revision as good (P(good)=${evalResult.posteriorGood.toFixed(4)} >= ${confidenceThreshold} after ${sample} samples; ${passedRuns} passed, ${failedRuns} failed)`,
              "automated",
              {
                sampleCount: sample,
                passedRuns,
                failedRuns,
                skippedRuns,
                posterior: evalResult.posteriorBad,
                confidenceThreshold,
              }
            );
            break;
          }
        }

        if (!finalOutcome) {
          const evalResult = evaluateBayesianDecision({
            passes: passedRuns,
            fails: failedRuns,
            confidenceThreshold,
            flakeRate,
          });
          finalOutcome = makeOutcome(
            "skip",
            "skip_budget_exceeded",
            `Noisy oracle sampling budget exhausted (${maxSamples} samples; ${passedRuns} passed, ${failedRuns} failed, ${skippedRuns} skipped) without reaching confidence threshold ${confidenceThreshold} (P(bad)=${evalResult.posteriorBad.toFixed(4)})`,
            "automated",
            {
              sampleCount: maxSamples,
              passedRuns,
              failedRuns,
              skippedRuns,
              posterior: evalResult.posteriorBad,
              confidenceThreshold,
            }
          );
        }
      } else {
        const oracleRes = await runAndRecordStep({
          sessionId: params.sessionId,
          ledgerPath: params.ledgerPath,
          commitSha: params.commitSha,
          phase: oraclePhase,
          commandSpec: oracleCommandSpec,
          cwd: stepCwd,
          config: params.config,
          detectedToolchainVersion: detectedVersion,
          abortSignal: params.abortSignal,
          onEvent: params.onEvent,
        });
        lastRunResult = oracleRes;

        finalOutcome = classifyOracleStep(oracleRes, params.config.profile);
      }
    }

    if (
      params.config.execution.interactivePrompt === true &&
      (params.phasePrefix === "oracle" || params.phasePrefix === undefined) &&
      finalOutcome
    ) {
      finalOutcome = await promptHumanClassification({
        commitSha: params.commitSha,
        commandSpec: oracleCommandSpec,
        automatedOutcome: finalOutcome,
        capturedOutput: lastRunResult ? { stdout: lastRunResult.stdout, stderr: lastRunResult.stderr } : undefined,
        executionInfo: lastRunResult?.timedOut
          ? `Command timed out after ${lastRunResult.durationMs}ms`
          : lastRunResult?.spawnErrorMessage
            ? `Spawn error: ${lastRunResult.spawnErrorMessage}`
            : undefined,
        streams: params.promptStreams,
        abortSignal: params.abortSignal,
      });
    }

    return finalOutcome!;
  } finally {
    for (const target of copiedOverlayTargets) {
      rmSync(target, { force: true, recursive: true });
    }
    if (copiedOverlayTargets.length > 0) {
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "cleanup_step",
          sessionId: params.sessionId,
          action: "overlay_removed",
          targetPath: copiedOverlayTargets.join(","),
          ok: copiedOverlayTargets.every((p) => !existsSync(p)),
        },
        params.onEvent
      );
    }
    if (finalOutcome) {
      appendLedgerEvent(
        params.ledgerPath,
        {
          type: "revision_classified",
          sessionId: params.sessionId,
          commitSha: params.commitSha,
          classification: finalOutcome.kind,
          reasonCode: finalOutcome.reasonCode,
          detail: finalOutcome.detail,
          gitExitCode: finalOutcome.gitExitCode,
          overlayHashes: params.overlayHashes,
          classifiedBy: finalOutcome.classifiedBy ?? "automated",
          ...(finalOutcome.noisySampling ? { noisySampling: finalOutcome.noisySampling } : {}),
          toolchainInfo: {
            ...(toolchain.detectedNodeSpec ? { detectedNodeSpec: toolchain.detectedNodeSpec } : {}),
            runningNodeVersion: toolchain.runningNodeVersion,
            ...(toolchain.packageManager ? { packageManager: toolchain.packageManager } : {}),
          },
        },
        params.onEvent
      );
    }
  }
}
