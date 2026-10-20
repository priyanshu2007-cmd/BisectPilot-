import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionManifestV1, SessionRepositoryMetadata } from "../../contracts/index.js";
import { ensureBisectPilotExcluded, resolveCommonGitDir, resolveGitPath, runGit } from "./git-client.js";

const OWNERSHIP_MARKER_FILE = "bisectpilot-owned.json";

export interface WorktreeOwnershipMarker {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly rootPath: string;
  readonly commonGitDir: string;
  readonly worktreePath: string;
  readonly createdByTool: true;
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function createSessionWorktree(params: {
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly commonGitDir: string;
  readonly originalHead: string | null;
  readonly originalWasDirty: boolean;
  readonly worktreePath: string;
  readonly initialCommitSha: string;
}): Promise<SessionRepositoryMetadata> {
  const resolvedRoot = safeRealpath(params.repoRoot);
  const resolvedCommon = safeRealpath(params.commonGitDir);
  ensureBisectPilotExcluded(resolvedCommon);
  const resolvedWorktree = path.resolve(params.worktreePath);

  if (resolvedWorktree === resolvedRoot) {
    throw new Error("Refusing to use original repository root as session worktree");
  }
  mkdirSync(path.dirname(resolvedWorktree), { recursive: true });

  const addRes = await runGit(
    ["worktree", "add", "--detach", resolvedWorktree, params.initialCommitSha],
    resolvedRoot
  );
  if (addRes.exitCode !== 0) {
    throw new Error(`Failed to create detached worktree at ${resolvedWorktree}: ${addRes.stderr}`);
  }

  const actualWorktree = safeRealpath(resolvedWorktree);
  const markerPath = await resolveGitPath(actualWorktree, OWNERSHIP_MARKER_FILE);
  const marker: WorktreeOwnershipMarker = {
    schemaVersion: 1,
    sessionId: params.sessionId,
    rootPath: resolvedRoot,
    commonGitDir: resolvedCommon,
    worktreePath: actualWorktree,
    createdByTool: true,
  };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");

  return {
    rootPath: resolvedRoot,
    commonGitDir: resolvedCommon,
    originalHead: params.originalHead,
    originalWasDirty: params.originalWasDirty,
    worktreePath: actualWorktree,
    createdByTool: true,
  };
}

/**
 * Single guarded verification gate required before any destructive worktree reset or removal (Section 26.3 & 8.4).
 */
export async function verifyWorktreeOwnership(
  manifest: Pick<SessionManifestV1, "id" | "repository">,
  candidateWorktreePath: string
): Promise<string> {
  if (manifest.repository.createdByTool !== true) {
    throw new Error("Refusing operation: worktree was not marked createdByTool=true in manifest");
  }
  const resolvedCandidate = safeRealpath(candidateWorktreePath);
  const resolvedManifestWorktree = safeRealpath(manifest.repository.worktreePath);
  const resolvedOriginalRoot = safeRealpath(manifest.repository.rootPath);

  if (resolvedCandidate === resolvedOriginalRoot) {
    throw new Error("Refusing destructive operation on original repository checkout");
  }
  if (resolvedCandidate !== resolvedManifestWorktree) {
    throw new Error(
      `Worktree path mismatch: candidate ${resolvedCandidate} !== manifest ${resolvedManifestWorktree}`
    );
  }
  if (!existsSync(resolvedCandidate)) {
    throw new Error(`Worktree path does not exist: ${resolvedCandidate}`);
  }

  const actualCommonGitDir = safeRealpath(await resolveCommonGitDir(resolvedCandidate));
  const expectedCommonGitDir = safeRealpath(manifest.repository.commonGitDir);
  if (actualCommonGitDir !== expectedCommonGitDir) {
    throw new Error(
      `Repository commonGitDir mismatch: ${actualCommonGitDir} !== ${expectedCommonGitDir}`
    );
  }

  const markerPath = await resolveGitPath(resolvedCandidate, OWNERSHIP_MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw new Error(`Missing BisectPilot ownership marker in worktree git dir: ${markerPath}`);
  }
  let parsedMarker: WorktreeOwnershipMarker;
  try {
    parsedMarker = JSON.parse(readFileSync(markerPath, "utf-8")) as WorktreeOwnershipMarker;
  } catch {
    throw new Error(`Corrupt BisectPilot ownership marker at ${markerPath}`);
  }
  if (
    parsedMarker.createdByTool !== true ||
    parsedMarker.sessionId !== manifest.id ||
    safeRealpath(parsedMarker.worktreePath) !== resolvedCandidate
  ) {
    throw new Error(`Ownership marker mismatch for session ${manifest.id}`);
  }

  return resolvedCandidate;
}

export async function resetOwnedWorktree(
  manifest: Pick<SessionManifestV1, "id" | "repository">,
  options?: {
    readonly cleanIgnored?: boolean;
    readonly overlayRelativePaths?: readonly string[];
  }
): Promise<void> {
  const worktreePath = await verifyWorktreeOwnership(manifest, manifest.repository.worktreePath);

  if (options?.overlayRelativePaths) {
    for (const rel of options.overlayRelativePaths) {
      const target = path.resolve(worktreePath, rel);
      if (target.startsWith(worktreePath + path.sep)) {
        rmSync(target, { force: true, recursive: true });
      }
    }
  }

  const resetRes = await runGit(["reset", "--hard"], worktreePath);
  if (resetRes.exitCode !== 0) {
    throw new Error(`worktree_not_clean: git reset --hard failed: ${resetRes.stderr}`);
  }

  const cleanFlags = options?.cleanIgnored ? "-fdx" : "-fd";
  const cleanRes = await runGit(["clean", cleanFlags], worktreePath);
  if (cleanRes.exitCode !== 0) {
    throw new Error(`worktree_not_clean: git clean ${cleanFlags} failed: ${cleanRes.stderr}`);
  }

  const statusRes = await runGit(["status", "--porcelain"], worktreePath);
  if (statusRes.exitCode !== 0 || statusRes.stdout.trim().length > 0) {
    throw new Error(
      `worktree_not_clean: dirty files remain after reset/clean: ${statusRes.stdout || statusRes.stderr}`
    );
  }
}

export async function removeOwnedWorktree(
  manifest: Pick<SessionManifestV1, "id" | "repository">,
  options?: { readonly dryRun?: boolean }
): Promise<{ readonly removed: boolean; readonly worktreePath: string }> {
  const worktreePath = await verifyWorktreeOwnership(manifest, manifest.repository.worktreePath);
  if (options?.dryRun) {
    return { removed: false, worktreePath };
  }

  await runGit(["bisect", "reset"], worktreePath).catch(() => undefined);

  const removeRes = await runGit(
    ["worktree", "remove", "--force", worktreePath],
    manifest.repository.rootPath
  );
  if (removeRes.exitCode !== 0 && existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    await runGit(["worktree", "prune"], manifest.repository.rootPath);
  }
  return { removed: !existsSync(worktreePath), worktreePath };
}
