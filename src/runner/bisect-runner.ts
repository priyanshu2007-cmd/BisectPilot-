#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { getCurrentHead } from "../git/index.js";
import { evaluateCheckedOutRevision } from "../oracle/index.js";
import { readSessionManifest, writeSessionManifestAtomic } from "../session/index.js";
import { resetOwnedWorktree } from "../worktree/index.js";

export async function executeSingleBisectStep(sessionDir: string): Promise<0 | 1 | 125 | 128> {
  let manifest;
  try {
    manifest = readSessionManifest(sessionDir);
  } catch {
    return 128;
  }

  const worktreePath = manifest.repository.worktreePath;
  const currentSha = await getCurrentHead(worktreePath);
  if (!currentSha) {
    return 128;
  }

  try {
    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });
  } catch {
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
  });

  try {
    await resetOwnedWorktree(manifest, {
      cleanIgnored: manifest.config.execution.cleanIgnored,
      overlayRelativePaths: manifest.config.oracle.overlayFiles,
    });
  } catch {
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

  if (outcome.kind === "skip" && nextSkipCount > manifest.config.execution.maxSkips) {
    return 128;
  }

  return outcome.gitExitCode;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const idx = process.argv.indexOf("--session-dir");
  const sessionDir = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!sessionDir) {
    process.exit(128);
  }
  executeSingleBisectStep(sessionDir)
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(128);
    });
}
