import type {
  BisectPlanReport,
  SessionManifestV1,
  StartSessionOptions,
} from "../contracts/index.js";
import { getGoodEndpointDiscoveryCandidates, runGit } from "../git/index.js";
import { appendLedgerEvent } from "../ledger/index.js";
import { evaluateCheckedOutRevision } from "../oracle/index.js";
import type { SandboxRuntimeExecutor } from "../process/index.js";
import {
  transitionSessionState,
  writeSessionCheckpointAtomic,
  writeSessionManifestAtomic,
} from "../session/index.js";
import { resetOwnedWorktree } from "../worktree/index.js";
import { executeInvestigationFromWorktreeReady } from "./investigation.js";
import { cancelSession, concludeSession } from "./lifecycle.js";
import { createBisectPlan } from "./preflight.js";

export async function discoverGoodEndpointAndRun(
  initialManifest: SessionManifestV1,
  planReport: BisectPlanReport,
  options?: StartSessionOptions,
  sandboxRuntimeExecutor?: SandboxRuntimeExecutor
): Promise<SessionManifestV1> {
  let manifest = initialManifest;

  if (options?.abortSignal?.aborted) {
    return cancelSession(manifest, options);
  }

  manifest = transitionSessionState(
    manifest,
    "preflight_running",
    "Validating bad endpoint before good-endpoint discovery",
    options?.onEvent
  );

  // 1. Evaluate bad endpoint
  const badOutcome = await evaluateCheckedOutRevision({
    sessionId: manifest.id,
    sessionDir: manifest.sessionDir,
    ledgerPath: manifest.ledgerPath,
    worktreePath: manifest.repository.worktreePath,
    commitSha: manifest.bounds.badSha,
    config: manifest.config,
    overlayHashes: manifest.overlayHashes,
    phasePrefix: "preflight_bad",
    abortSignal: options?.abortSignal,
    onEvent: options?.onEvent,
    sandboxRuntimeExecutor: sandboxRuntimeExecutor,
  });

  if (options?.abortSignal?.aborted) {
    return cancelSession(manifest, options);
  }

  if (badOutcome.kind === "good") {
    return concludeSession(
      manifest,
      {
        outcome: "inconclusive",
        skippedShas: [],
        explanation:
          "Automatic discovery failed: bad endpoint passed oracle (cannot establish regression baseline when bad endpoint does not fail).",
      },
      options
    );
  }

  if (badOutcome.kind === "abort") {
    return concludeSession(
      manifest,
      {
        outcome: "aborted",
        skippedShas: [],
        explanation: `Bad endpoint execution aborted: ${badOutcome.detail}`,
      },
      options
    );
  }

  // 2. Discover ancestor candidates using tags and exponential distances
  const candidates = await getGoodEndpointDiscoveryCandidates(
    planReport.repoRoot,
    manifest.bounds.badSha
  );

  let discoveredGoodSha: string | null = null;

  for (const candidateSha of candidates) {
    if (options?.abortSignal?.aborted) {
      return cancelSession(manifest, options);
    }

    const coRes = await runGit(
      ["checkout", "--detach", candidateSha],
      manifest.repository.worktreePath
    );
    if (coRes.exitCode !== 0) continue;

    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });

    const candOutcome = await evaluateCheckedOutRevision({
      sessionId: manifest.id,
      sessionDir: manifest.sessionDir,
      ledgerPath: manifest.ledgerPath,
      worktreePath: manifest.repository.worktreePath,
      commitSha: candidateSha,
      config: manifest.config,
      overlayHashes: manifest.overlayHashes,
      phasePrefix: "preflight_good",
      abortSignal: options?.abortSignal,
      onEvent: options?.onEvent,
      sandboxRuntimeExecutor: sandboxRuntimeExecutor,
    });

    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });

    appendLedgerEvent(
      manifest.ledgerPath,
      {
        type: "boundary_check",
        sessionId: manifest.id,
        target: "good_endpoint",
        commitSha: candidateSha,
        totalRuns: 1,
        passedRuns: candOutcome.kind === "good" ? 1 : 0,
        failedRuns: candOutcome.kind === "bad" ? 1 : 0,
        skippedRuns: candOutcome.kind === "skip" ? 1 : 0,
        abortedRuns: candOutcome.kind === "abort" ? 1 : 0,
      },
      options?.onEvent
    );

    if (candOutcome.kind === "good") {
      discoveredGoodSha = candidateSha;
      break;
    }
  }

  if (!discoveredGoodSha) {
    return concludeSession(
      manifest,
      {
        outcome: "inconclusive",
        skippedShas: [],
        explanation:
          "Automatic good-endpoint discovery exhausted candidate history without finding a commit passing the oracle.",
      },
      options
    );
  }

  // 3. Update manifest and config with discovered good endpoint
  manifest = {
    ...manifest,
    bounds: {
      ...manifest.bounds,
      goodSha: discoveredGoodSha,
    },
    config: {
      ...manifest.config,
      goodRef: discoveredGoodSha,
    },
  };
  writeSessionManifestAtomic(manifest);

  // 4. Request consent if configured
  if (manifest.config.execution.confirmBeforeExecutingCode && options?.confirm) {
    manifest = transitionSessionState(
      manifest,
      "awaiting_consent",
      `Discovered good baseline: ${discoveredGoodSha}`,
      options?.onEvent
    );
    const updatedPlan = await createBisectPlan(manifest.config);
    const approved = await options.confirm(updatedPlan);
    if (!approved) {
      manifest = transitionSessionState(
        manifest,
        "cancelled",
        "User declined consent after good-endpoint discovery",
        options?.onEvent
      );
      return manifest;
    }
  }

  manifest = transitionSessionState(
    manifest,
    "worktree_ready",
    `Discovered good endpoint ${discoveredGoodSha}; ready for bisection`,
    options?.onEvent
  );

  // 5. Continue to bisection (skip preflight since endpoints were already verified during discovery)
  return await executeInvestigationFromWorktreeReady(manifest, {
    ...options,
    skipPreflight: true,
  });
  }
