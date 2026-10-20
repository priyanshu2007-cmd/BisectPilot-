import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BisectConfigV1,
  BisectPlanReport,
  LedgerEvent,
  SessionManifestV1,
} from "../contracts/index.js";
import {
  countCommitsBetween,
  getGoodEndpointDiscoveryCandidates,
  isAncestor,
  isWorkingTreeDirty,
  resolveRefToSha,
  resolveRepoRoot,
  runGit,
} from "../git/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import { evaluateCheckedOutRevision } from "../oracle/index.js";
import type { SandboxRuntimeExecutor } from "../process/index.js";
import { resolveWorkspacePathScope, validateWorkspacePath } from "../domain/workspace.js";
import { resetOwnedWorktree } from "../worktree/index.js";

export function resolveRunnerScriptPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../runner/bisect-runner.js");
}

export function defaultSessionRootDir(repoRoot: string, configuredRoot?: string): string {
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  return path.resolve(repoRoot, ".bisectpilot", "sessions");
}

export async function createBisectPlan(config: BisectConfigV1): Promise<BisectPlanReport> {
  const repoRoot = await resolveRepoRoot(config.repositoryRoot);
  const badSha = await resolveRefToSha(repoRoot, config.badRef);
  const dirty = await isWorkingTreeDirty(repoRoot);
  const warnings: string[] = [];

  if (config.workingDirectory && config.workingDirectory !== ".") {
    const wsVal = validateWorkspacePath(repoRoot, config.workingDirectory);
    if (!wsVal.ok) {
      return {
        ok: false,
        repoRoot,
        goodSha:
          config.goodRef === "auto"
            ? "auto"
            : await resolveRefToSha(repoRoot, config.goodRef).catch(() => "unknown"),
        badSha,
        isLinearAncestor: false,
        estimatedCommitsBetween: 0,
        estimatedSteps: 0,
        originalWasDirty: dirty,
        warnings: [`Workspace path error: ${wsVal.error}`],
      };
    }
    warnings.push(
      `Workspace mode active: path-scoped history limited to "${config.workingDirectory}" and root dependencies.`
    );
  }

  const pathScope = resolveWorkspacePathScope(repoRoot, config.workingDirectory || ".", config.pathScope);

  if (config.goodRef === "auto") {
    const candidates = await getGoodEndpointDiscoveryCandidates(repoRoot, badSha);
    if (dirty) {
      warnings.push(
        "Original working tree has uncommitted changes (BisectPilot will preserve them in place and bisect in an isolated detached worktree)."
      );
    }
    if (candidates.length === 0) {
      return {
        ok: false,
        repoRoot,
        goodSha: "auto",
        badSha,
        isLinearAncestor: false,
        estimatedCommitsBetween: 0,
        estimatedSteps: 0,
        originalWasDirty: dirty,
        warnings: ["badRef has no ancestors in repository; automatic good discovery impossible."],
      };
    }
    warnings.push("goodRef is set to auto; good endpoint will be discovered dynamically from ancestor candidates.");
    return {
      ok: true,
      repoRoot,
      goodSha: "auto",
      badSha,
      isLinearAncestor: true,
      estimatedCommitsBetween: candidates.length,
      estimatedSteps: Math.ceil(Math.log2(candidates.length + 1)),
      originalWasDirty: dirty,
      warnings,
    };
  }

  const goodSha = await resolveRefToSha(repoRoot, config.goodRef);
  const linear = await isAncestor(repoRoot, goodSha, badSha);
  const commitsBetween = await countCommitsBetween(repoRoot, goodSha, badSha, pathScope);
  const steps = commitsBetween > 0 ? Math.ceil(Math.log2(commitsBetween + 1)) : 0;

  if (!linear) {
    warnings.push("goodRef is not a direct ancestor of badRef; non-linear history detected.");
  }
  if (dirty) {
    warnings.push(
      "Original working tree has uncommitted changes (BisectPilot will preserve them in place and bisect in an isolated detached worktree)."
    );
  }
  if (commitsBetween === 0 && pathScope && pathScope.length > 0) {
    warnings.push(
      `No commits found between ${goodSha.slice(0, 7)} and ${badSha.slice(0, 7)} affecting workspace "${config.workingDirectory}" or root dependencies.`
    );
  }
  if (config.profile === "performance" && config.benchmark) {
    warnings.push(
      `Performance benchmark mode active: measuring metric "${config.benchmark.metric}" (${config.benchmark.direction}, samples: ${config.benchmark.minSamples}-${config.benchmark.maxSamples}, alpha: ${config.benchmark.alpha}).`
    );
  }

  return {
    ok: linear && commitsBetween > 0,
    repoRoot,
    goodSha,
    badSha,
    isLinearAncestor: linear,
    estimatedCommitsBetween: commitsBetween,
    estimatedSteps: steps,
    originalWasDirty: dirty,
    warnings,
  };
}

export async function runEndpointKTimes(params: {
  readonly manifest: SessionManifestV1;
  readonly target: "good_endpoint" | "bad_endpoint" | "candidate" | "candidate_parent";
  readonly commitSha: string;
  readonly runs: number;
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: LedgerEvent) => void;
  readonly sandboxRuntimeExecutor?: SandboxRuntimeExecutor;
}): Promise<{
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly aborted: number;
}> {
  const worktreePath = params.manifest.repository.worktreePath;
  const coRes = await runGit(["checkout", "--detach", params.commitSha], worktreePath);
  if (coRes.exitCode !== 0) {
    throw new Error(`Failed to checkout ${params.commitSha} in worktree: ${coRes.stderr}`);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = 0;

  for (let i = 0; i < params.runs; i++) {
    await resetOwnedWorktree(params.manifest, {
      cleanIgnored: params.manifest.config.execution.cleanIgnored,
      overlayRelativePaths: params.manifest.config.oracle.overlayFiles,
    });

    const outcome = await evaluateCheckedOutRevision({
      sessionId: params.manifest.id,
      sessionDir: params.manifest.sessionDir,
      ledgerPath: params.manifest.ledgerPath,
      worktreePath,
      commitSha: params.commitSha,
      config: params.manifest.config,
      overlayHashes: params.manifest.overlayHashes,
      phasePrefix:
        params.target === "good_endpoint"
          ? "preflight_good"
          : params.target === "bad_endpoint"
            ? "preflight_bad"
            : "boundary_check",
      abortSignal: params.abortSignal,
      onEvent: params.onEvent,
      sandboxRuntimeExecutor: params.sandboxRuntimeExecutor,
      benchmarkBaseline: params.manifest.benchmarkBaseline,
    });

    await resetOwnedWorktree(params.manifest, {
      cleanIgnored: params.manifest.config.execution.cleanIgnored,
      overlayRelativePaths: params.manifest.config.oracle.overlayFiles,
    });

    if (outcome.kind === "good") passed++;
    else if (outcome.kind === "bad") failed++;
    else if (outcome.kind === "skip") skipped++;
    else {
      aborted++;
      break;
    }
  }

  appendLedgerEvent(
    params.manifest.ledgerPath,
    {
      type: "boundary_check",
      sessionId: params.manifest.id,
      target: params.target,
      commitSha: params.commitSha,
      totalRuns: params.runs,
      passedRuns: passed,
      failedRuns: failed,
      skippedRuns: skipped,
      abortedRuns: aborted,
    },
    params.onEvent
  );

  return { passed, failed, skipped, aborted };
}

export function parseFirstBadShaFromBisectOutput(output: string, termNew = "bad"): string | undefined {
  const escapedTerm = termNew.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex1 = new RegExp(`\\b([0-9a-f]{40}) is the first (?:['"]?(?:${escapedTerm}|bad)['"]?) commit\\b`, "i");
  const match1 = regex1.exec(output);
  if (match1) return match1[1]!.toLowerCase();

  const regex2 = new RegExp(`# first (?:['"]?(?:${escapedTerm}|bad)['"]?) commit:\\s*\\[([0-9a-f]{40})\\]`, "i");
  const match2 = regex2.exec(output);
  if (match2) return match2[1]!.toLowerCase();

  const regex3 = /\b([0-9a-f]{40}) is the first ['"]?[^'"\r\n]+['"]? commit\b/i;
  const match3 = regex3.exec(output);
  if (match3) return match3[1]!.toLowerCase();

  const regex4 = /# first [^:\r\n]+ commit:\s*\[([0-9a-f]{40})\]/i;
  const match4 = regex4.exec(output);
  if (match4) return match4[1]!.toLowerCase();

  return undefined;
}
