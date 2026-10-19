import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
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
import { runGit } from "../git/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import { runSafeProcess, type ProcessRunResult } from "../process/index.js";

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

export async function isPathTrackedInRevision(
  worktreePath: string,
  relPath: string
): Promise<boolean> {
  const res = await runGit(["ls-files", "--error-unmatch", "--", relPath], worktreePath);
  return res.exitCode === 0;
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
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
}): Promise<ProcessRunResult> {
  appendLedgerEvent(
    params.ledgerPath,
    {
      type: "process_starting",
      sessionId: params.sessionId,
      commitSha: params.commitSha,
      phase: params.phase,
      command: params.commandSpec.command,
      args: params.commandSpec.args,
      cwd: params.cwd,
    },
    params.onEvent
  );

  const result = await runSafeProcess({
    commandSpec: params.commandSpec,
    cwd: params.cwd,
    executionPolicy: params.config.execution,
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

  if (params.config.execution.enforceNodeToolchainCheck !== false && toolchain.mismatch) {
    const outcome = makeOutcome(
      "skip",
      "toolchain_mismatch",
      `Revision requires Node ${toolchain.detectedNodeSpec} (major ${toolchain.requiredMajor}), running ${toolchain.runningNodeVersion}`
    );
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

    if (params.config.prepare) {
      const prepRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "prepare",
        commandSpec: params.config.prepare,
        cwd: stepCwd,
        config: params.config,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
      });
      const prepClassification = classifyPrepareStep(prepRes);
      if (prepClassification) {
        finalOutcome = prepClassification;
        return finalOutcome;
      }
    }

    if (params.config.build) {
      const buildRes = await runAndRecordStep({
        sessionId: params.sessionId,
        ledgerPath: params.ledgerPath,
        commitSha: params.commitSha,
        phase: "build",
        commandSpec: params.config.build,
        cwd: stepCwd,
        config: params.config,
        abortSignal: params.abortSignal,
        onEvent: params.onEvent,
      });
      const buildClassification = classifyBuildStep(
        buildRes,
        params.config.profile,
        params.config.build
      );
      if (buildClassification) {
        finalOutcome = buildClassification;
        return finalOutcome;
      }
    }

    const oraclePhase: StepPhase = params.phasePrefix ?? "oracle";
    const oracleRes = await runAndRecordStep({
      sessionId: params.sessionId,
      ledgerPath: params.ledgerPath,
      commitSha: params.commitSha,
      phase: oraclePhase,
      commandSpec: params.config.oracle.command,
      cwd: stepCwd,
      config: params.config,
      abortSignal: params.abortSignal,
      onEvent: params.onEvent,
    });

    finalOutcome = classifyOracleStep(oracleRes, params.config.profile);
    return finalOutcome;
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
