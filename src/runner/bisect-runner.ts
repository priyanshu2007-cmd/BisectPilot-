#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentHead } from "../git/index.js";
import { readLedgerEvents } from "../ledger/index.js";
import { evaluateCheckedOutRevision } from "../oracle/index.js";
import {
  readSessionCheckpoint,
  readSessionManifest,
  recordRevisionClassificationCheckpoint,
  writeSessionManifestAtomic,
} from "../session/index.js";
import { resetOwnedWorktree } from "../worktree/index.js";

export async function executeSingleBisectStep(sessionDir: string): Promise<0 | 1 | 125 | 128> {
  let manifest;
  try {
    manifest = readSessionManifest(sessionDir);
  } catch (err) {
    console.error(`[bisect-runner] Failed to read session manifest from ${sessionDir}:`, err);
    return 128;
  }

  const worktreePath = manifest.repository.worktreePath;
  const currentSha = await getCurrentHead(worktreePath);
  if (!currentSha) {
    console.error(`[bisect-runner] Failed to get HEAD commit SHA from worktree ${worktreePath}`);
    return 128;
  }

  // Fast resume: if this revision is already authoritatively classified in checkpoint/WAL,
  // reuse its authoritative outcome immediately without repeating expensive builds/tests.
  try {
    const { checkpoint } = readSessionCheckpoint(sessionDir);
    const cached = checkpoint.classifications[currentSha];
    if (cached) {
      return cached.gitExitCode;
    }
  } catch {
    // Proceed with live evaluation if checkpoint read fails
  }

  try {
    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });
  } catch (err) {
    console.error(`[bisect-runner] resetOwnedWorktree failed before eval (${currentSha}):`, err);
    return 128;
  }

  const outcome = await evaluateCheckedOutRevision({
    sessionId: manifest.id,
    sessionDir: manifest.sessionDir,
    ledgerPath: manifest.ledgerPath,
    worktreePath,
    commitSha: currentSha,
    config: manifest.config,
    overlayHashes: manifest.overlayHashes,
    phasePrefix: "oracle",
    benchmarkBaseline: manifest.benchmarkBaseline,
  });

  try {
    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });
  } catch (err) {
    console.error(`[bisect-runner] resetOwnedWorktree failed after eval (${currentSha}):`, err);
    return 128;
  }

  const nextSkipCount = outcome.kind === "skip" ? manifest.skipCount + 1 : manifest.skipCount;
  const updatedManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    skipCount: nextSkipCount,
    testedRevisions: [...manifest.testedRevisions, currentSha],
    lastRecordedRevision: currentSha,
  };
  writeSessionManifestAtomic(updatedManifest);

  try {
    const events = readLedgerEvents(manifest.ledgerPath);
    recordRevisionClassificationCheckpoint(
      sessionDir,
      {
        commitSha: currentSha,
        classification: outcome.kind === "good" ? "good" : outcome.kind === "bad" ? "bad" : outcome.kind === "skip" ? "skip" : "abort",
        reasonCode: outcome.reasonCode,
        gitExitCode: outcome.gitExitCode,
        detail: outcome.detail,
        durationMs: undefined,
        noisySampling: outcome.noisySampling,
        benchmark: outcome.benchmark as any,
        classifiedAt: new Date().toISOString(),
      },
      events.length
    );
  } catch {
    // Non-fatal if checkpoint snapshot update fails
  }

  if (outcome.kind === "skip" && nextSkipCount > manifest.config.execution.maxSkips) {
    return 128;
  }

  return outcome.gitExitCode;
}

function isEntrypoint(): boolean {
  if (process.argv.includes("--session-dir")) return true;
  if (!process.argv[1]) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    if (thisFile === process.argv[1]) return true;
    if (path.resolve(thisFile).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) return true;
    return fs.realpathSync(thisFile) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const idx = process.argv.indexOf("--session-dir");
  const sessionDir = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!sessionDir) {
    console.error("[bisect-runner] Missing required --session-dir argument");
    process.exit(128);
  }
  executeSingleBisectStep(sessionDir)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error("[bisect-runner] Uncaught fatal error in executeSingleBisectStep:", err);
      process.exit(128);
    });
}
