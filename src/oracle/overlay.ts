import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { runGit } from "../git/index.js";

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
  const realRepoRoot = realpathSync(repoRoot);
  const isInside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };

  for (const relPath of overlayFiles) {
    if (path.isAbsolute(relPath) || relPath.includes("\0")) throw new Error(`Overlay path must be relative: ${relPath}`);
    const normalizedRel = path.normalize(relPath);
    if (normalizedRel === ".." || normalizedRel.startsWith(`..${path.sep}`)) throw new Error(`Overlay path escapes repository: ${relPath}`);
    const sourcePath = path.resolve(repoRoot, normalizedRel);
    if (!existsSync(sourcePath)) {
      throw new Error(`Overlay file not found at ${sourcePath}`);
    }
    const realSourcePath = realpathSync(sourcePath);
    if (!isInside(realRepoRoot, realSourcePath)) throw new Error(`Overlay path resolves outside repository: ${relPath}`);
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
  if (path.isAbsolute(externalScriptPath) || externalScriptPath.includes("\0")) throw new Error("External oracle script path must be relative");
  const sourcePath = path.resolve(repoRoot, externalScriptPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`External oracle script not found at ${sourcePath}`);
  }
  const realRepoRoot = realpathSync(repoRoot);
  const realSourcePath = realpathSync(sourcePath);
  const relative = path.relative(realRepoRoot, realSourcePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("External oracle script resolves outside repository");
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

