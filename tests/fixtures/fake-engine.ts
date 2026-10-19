import type {
  BisectConfigV1,
  BisectEngine,
  BisectPlanReport,
  CleanupOptions,
  CleanupResult,
  DoctorReport,
  LedgerEvent,
  SessionManifestV1,
  SessionStatusReport,
  StartSessionOptions,
} from "../../src/contracts/index.js";
import { GENESIS_PREV_HASH } from "../../src/contracts/ledger.js";

/**
 * Deterministic FakeEngine for CLI & report unit tests (Section 28.1).
 * Isolated in test fixtures so production modules do not carry mock state.
 */
export class FakeEngine implements BisectEngine {
  private readonly sessions = new Map<string, SessionManifestV1>();

  async doctor(repoPath = "."): Promise<DoctorReport> {
    return {
      ok: true,
      gitVersion: "2.45.2",
      repoRoot: repoPath,
      commonGitDir: `${repoPath}/.git`,
      checks: [
        {
          id: "git_version",
          ok: true,
          severity: "info",
          summary: "Git 2.45.2 meets >= 2.36 requirement",
        },
      ],
    };
  }

  async plan(config: BisectConfigV1): Promise<BisectPlanReport> {
    return {
      ok: true,
      repoRoot: config.repositoryRoot,
      goodSha: "1111111111111111111111111111111111111111",
      badSha: "9999999999999999999999999999999999999999",
      isLinearAncestor: true,
      estimatedCommitsBetween: 8,
      estimatedSteps: 3,
      originalWasDirty: false,
      warnings: [],
    };
  }

  async start(config: BisectConfigV1, options?: StartSessionOptions): Promise<SessionManifestV1> {
    const id = options?.sessionId ?? "fake-session-01";
    const planReport = await this.plan(config);
    if (options?.confirm) {
      const approved = await options.confirm(planReport);
      if (!approved) {
        const cancelledManifest: SessionManifestV1 = {
          schemaVersion: 1,
          id,
          createdAt: "2026-10-19T00:00:00.000Z",
          updatedAt: "2026-10-19T00:00:01.000Z",
          state: "cancelled",
          sessionDir: `/tmp/${id}`,
          ledgerPath: `/tmp/${id}/ledger.jsonl`,
          repository: {
            rootPath: config.repositoryRoot,
            commonGitDir: `${config.repositoryRoot}/.git`,
            originalHead: planReport.badSha,
            originalWasDirty: false,
            worktreePath: `/tmp/${id}/worktree`,
            createdByTool: true,
          },
          bounds: {
            goodInputRef: config.goodRef,
            goodSha: planReport.goodSha,
            badInputRef: config.badRef,
            badSha: planReport.badSha,
          },
          configHash: "fake-config-hash",
          config,
          overlayHashes: {},
          skipCount: 0,
          testedRevisions: [],
          runnerVersion: "0.1.0",
        };
        this.sessions.set(id, cancelledManifest);
        return cancelledManifest;
      }
    }

    const event: LedgerEvent = {
      schemaVersion: 1,
      seq: 1,
      sessionId: id,
      timestamp: "2026-10-19T00:00:00.000Z",
      prevHash: GENESIS_PREV_HASH,
      eventHash: "fake-hash-01",
      type: "session_created",
      goodSha: planReport.goodSha,
      badSha: planReport.badSha,
      worktreePath: `/tmp/${id}/worktree`,
      overlayHashes: {},
    };
    options?.onEvent?.(event);

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id,
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:05.000Z",
      state: "concluded",
      sessionDir: `/tmp/${id}`,
      ledgerPath: `/tmp/${id}/ledger.jsonl`,
      repository: {
        rootPath: config.repositoryRoot,
        commonGitDir: `${config.repositoryRoot}/.git`,
        originalHead: planReport.badSha,
        originalWasDirty: false,
        worktreePath: `/tmp/${id}/worktree`,
        createdByTool: true,
      },
      bounds: {
        goodInputRef: config.goodRef,
        goodSha: planReport.goodSha,
        badInputRef: config.badRef,
        badSha: planReport.badSha,
      },
      configHash: "fake-config-hash",
      config,
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: ["4444444444444444444444444444444444444444"],
      lastRecordedRevision: "4444444444444444444444444444444444444444",
      runnerVersion: "0.1.0",
      conclusion: {
        outcome: "candidate_confirmed",
        candidateSha: "4444444444444444444444444444444444444444",
        parentSha: "3333333333333333333333333333333333333333",
        skippedShas: [],
        explanation: "Candidate commit 44444444 confirmed by boundary verification.",
      },
    };
    this.sessions.set(id, manifest);
    return manifest;
  }

  async status(sessionId: string): Promise<SessionStatusReport> {
    const manifest = this.sessions.get(sessionId);
    if (!manifest) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return {
      manifest,
      lockStatus: "unlocked",
      eventCount: 1,
      ledgerValid: true,
    };
  }

  async resume(sessionId: string): Promise<SessionManifestV1> {
    const manifest = this.sessions.get(sessionId);
    if (!manifest) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return manifest;
  }

  async cleanup(sessionId: string, options?: CleanupOptions): Promise<CleanupResult> {
    const manifest = this.sessions.get(sessionId);
    if (!manifest) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const dryRun = Boolean(options?.dryRun);
    const nextState = dryRun ? manifest.state : "cleaned_up";
    if (!dryRun) {
      this.sessions.set(sessionId, { ...manifest, state: "cleaned_up" });
    }
    return {
      sessionId,
      worktreePath: manifest.repository.worktreePath,
      dryRun,
      removedWorktree: !dryRun,
      state: nextState,
      detail: dryRun ? "Dry-run: would remove tool-owned worktree" : "Removed tool-owned worktree",
    };
  }

  async list(): Promise<readonly SessionManifestV1[]> {
    return [...this.sessions.values()];
  }
}
