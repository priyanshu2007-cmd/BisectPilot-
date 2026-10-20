import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface WorkspaceValidationResult {
  readonly ok: boolean;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly error?: string;
}

export interface WorkspaceDependencyInspection {
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun" | "cargo" | "pip" | "unknown";
  readonly monorepoType:
    | "pnpm-workspace"
    | "npm-workspaces"
    | "yarn-workspaces"
    | "lerna"
    | "turbo"
    | "nx"
    | "cargo-workspace"
    | "none";
  readonly rootLockfileName?: string;
  readonly rootLockfileHash?: string;
  readonly rootManifestHash?: string;
  readonly workspaceManifestHash?: string;
  readonly workspaceRelPath: string;
}

const ROOT_DEPENDENCY_FILES: readonly string[] = Object.freeze([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "lerna.json",
  "turbo.json",
  "nx.json",
  ".nvmrc",
  ".node-version",
  "tsconfig.json",
]);

/**
 * Validates a user-supplied workspace path (from --cwd or config.workingDirectory)
 * against path traversal, symlink escapes, and root boundary violations.
 */
export function validateWorkspacePath(
  repoRoot: string,
  cwdInput: string
): WorkspaceValidationResult {
  if (!cwdInput || typeof cwdInput !== "string" || cwdInput.trim().length === 0) {
    return {
      ok: false,
      relativePath: ".",
      absolutePath: path.resolve(repoRoot),
      error: "Workspace path cannot be empty",
    };
  }
  if (/[\x00-\x1f\x7f]/.test(cwdInput)) {
    return {
      ok: false,
      relativePath: ".",
      absolutePath: path.resolve(repoRoot),
      error: "Workspace path cannot contain control characters or newlines",
    };
  }

  const trimmed = cwdInput.trim();
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedTarget = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedRepo, trimmed);

  const rel = path.relative(resolvedRepo, resolvedTarget);

  // Reject paths that escape the repository root
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      relativePath: rel,
      absolutePath: resolvedTarget,
      error: `Workspace path "${cwdInput}" escapes the repository root ("${repoRoot}")`,
    };
  }

  // Detect symlink-based escapes if target exists on disk
  if (existsSync(resolvedTarget)) {
    try {
      const realTarget = realpathSync(resolvedTarget);
      const realRepo = realpathSync(resolvedRepo);
      const realRel = path.relative(realRepo, realTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return {
          ok: false,
          relativePath: rel,
          absolutePath: resolvedTarget,
          error: `Workspace path "${cwdInput}" resolves via symlink outside the repository root`,
        };
      }
    } catch {
      return {
        ok: false,
        relativePath: rel,
        absolutePath: resolvedTarget,
        error: `Could not safely resolve real path for workspace "${cwdInput}"`,
      };
    }
  }

  const normalizedRel = rel === "" ? "." : rel.replace(/\\/g, "/");
  return {
    ok: true,
    relativePath: normalizedRel,
    absolutePath: resolvedTarget,
  };
}

/**
 * Computes the pathspec array to supply to git bisect start and rev-list.
 * Includes the workspace subdirectory plus root dependency files so root-level
 * or shared configuration changes are never silently excluded.
 */
export function resolveWorkspacePathScope(
  repoRoot: string,
  workingDirectory: string,
  customScope?: readonly string[]
): readonly string[] | undefined {
  if (customScope && customScope.length > 0) {
    return customScope;
  }
  if (!workingDirectory || workingDirectory === ".") {
    return undefined;
  }

  const normalizedWs = workingDirectory.replace(/\\/g, "/").replace(/^\.\//, "");
  const paths: string[] = [normalizedWs];

  for (const f of ROOT_DEPENDENCY_FILES) {
    paths.push(f);
  }

  return paths;
}

/**
 * Inspects package manifests, lockfiles, and monorepo configurations at the
 * checked-out revision, computing cryptographic hashes for tamper evidence.
 */
export function detectWorkspaceDependencies(
  rootPath: string,
  workingDirectory = "."
): WorkspaceDependencyInspection {
  const wsDir = path.resolve(rootPath, workingDirectory);

  let packageManager: WorkspaceDependencyInspection["packageManager"] = "unknown";
  let monorepoType: WorkspaceDependencyInspection["monorepoType"] = "none";
  let rootLockfileName: string | undefined;
  let rootLockfileHash: string | undefined;
  let rootManifestHash: string | undefined;
  let workspaceManifestHash: string | undefined;

  const rootLockCandidates = [
    { name: "pnpm-lock.yaml", pm: "pnpm" as const },
    { name: "package-lock.json", pm: "npm" as const },
    { name: "yarn.lock", pm: "yarn" as const },
    { name: "bun.lockb", pm: "bun" as const },
    { name: "Cargo.lock", pm: "cargo" as const },
  ];

  for (const candidate of rootLockCandidates) {
    const lockPath = path.join(rootPath, candidate.name);
    if (existsSync(lockPath)) {
      rootLockfileName = candidate.name;
      packageManager = candidate.pm;
      try {
        rootLockfileHash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
      } catch {
        // Ignore unreadable lockfile
      }
      break;
    }
  }

  if (existsSync(path.join(rootPath, "pnpm-workspace.yaml"))) {
    monorepoType = "pnpm-workspace";
    packageManager = "pnpm";
  } else if (existsSync(path.join(rootPath, "lerna.json"))) {
    monorepoType = "lerna";
  } else if (existsSync(path.join(rootPath, "turbo.json"))) {
    monorepoType = "turbo";
  } else if (existsSync(path.join(rootPath, "nx.json"))) {
    monorepoType = "nx";
  }

  const rootPkgPath = path.join(rootPath, "package.json");
  if (existsSync(rootPkgPath)) {
    try {
      const rawPkg = readFileSync(rootPkgPath, "utf-8");
      rootManifestHash = createHash("sha256").update(rawPkg).digest("hex");
      const rootPkg = JSON.parse(rawPkg) as {
        workspaces?: unknown;
        packageManager?: string;
      };
      if (monorepoType === "none" && rootPkg.workspaces) {
        monorepoType = "npm-workspaces";
      }
      if (packageManager === "unknown" && typeof rootPkg.packageManager === "string") {
        if (rootPkg.packageManager.startsWith("pnpm")) packageManager = "pnpm";
        else if (rootPkg.packageManager.startsWith("yarn")) packageManager = "yarn";
        else if (rootPkg.packageManager.startsWith("npm")) packageManager = "npm";
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  const wsPkgPath = path.join(wsDir, "package.json");
  if (existsSync(wsPkgPath)) {
    try {
      const wsPkg = JSON.parse(readFileSync(wsPkgPath, "utf-8"));
      workspaceManifestHash = createHash("sha256").update(JSON.stringify(wsPkg)).digest("hex");
    } catch {
      // Ignore malformed JSON
    }
  }

  return {
    packageManager,
    monorepoType,
    ...(rootLockfileName ? { rootLockfileName } : {}),
    ...(rootLockfileHash ? { rootLockfileHash } : {}),
    ...(rootManifestHash ? { rootManifestHash } : {}),
    ...(workspaceManifestHash ? { workspaceManifestHash } : {}),
    workspaceRelPath: workingDirectory,
  };
}
