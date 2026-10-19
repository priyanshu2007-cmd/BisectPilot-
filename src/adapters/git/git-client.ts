import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DoctorCheckResult, DoctorReport } from "../../contracts/index.js";

const execFileAsync = promisify(execFile);

export interface GitExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGit(args: readonly string[], cwd?: string): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
        HOME: process.env.HOME ?? "",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: (e.stdout ?? "").trimEnd(),
      stderr: (e.stderr ?? e.message ?? "").trimEnd(),
    };
  }
}

export interface ParsedGitVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseGitVersion(versionOutput: string): ParsedGitVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3] ?? "0"}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? "0"),
  };
}

export function isGitVersionSupported(ver: ParsedGitVersion): boolean {
  return ver.major > 2 || (ver.major === 2 && ver.minor >= 36);
}

export async function checkGitVersion(): Promise<{
  readonly ok: boolean;
  readonly version: ParsedGitVersion | null;
  readonly rawOutput: string;
}> {
  const res = await runGit(["--version"]);
  if (res.exitCode !== 0) {
    return { ok: false, version: null, rawOutput: res.stderr || res.stdout };
  }
  const parsed = parseGitVersion(res.stdout);
  if (!parsed) {
    return { ok: false, version: null, rawOutput: res.stdout };
  }
  return { ok: isGitVersionSupported(parsed), version: parsed, rawOutput: res.stdout };
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  const res = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (res.exitCode !== 0 || !res.stdout) {
    throw new Error(`Not a valid Git repository (${cwd}): ${res.stderr}`);
  }
  return path.resolve(res.stdout);
}

export async function resolveCommonGitDir(cwd: string): Promise<string> {
  const res = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (res.exitCode !== 0 || !res.stdout) {
    const fallback = await runGit(["rev-parse", "--git-common-dir"], cwd);
    if (fallback.exitCode !== 0 || !fallback.stdout) {
      throw new Error(`Failed to resolve common Git directory in ${cwd}: ${res.stderr}`);
    }
    return path.resolve(cwd, fallback.stdout);
  }
  return path.resolve(res.stdout);
}

export async function resolveGitPath(cwd: string, relativeGitPath: string): Promise<string> {
  const res = await runGit(["rev-parse", "--git-path", relativeGitPath], cwd);
  if (res.exitCode !== 0 || !res.stdout) {
    throw new Error(`Failed to resolve --git-path ${relativeGitPath} in ${cwd}: ${res.stderr}`);
  }
  return path.resolve(cwd, res.stdout);
}

export async function resolveRefToSha(cwd: string, ref: string): Promise<string> {
  const res = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  if (res.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(res.stdout)) {
    throw new Error(`Invalid commit reference "${ref}": ${res.stderr || "not a valid commit"}`);
  }
  return res.stdout.toLowerCase();
}

export async function getCurrentHead(cwd: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  if (res.exitCode !== 0) return null;
  return res.stdout.toLowerCase();
}

export async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain", "--untracked-files=normal"], cwd);
  if (res.exitCode !== 0) {
    throw new Error(`git status failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim().length > 0;
}

export async function isAncestor(cwd: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  const res = await runGit(["merge-base", "--is-ancestor", ancestorSha, descendantSha], cwd);
  return res.exitCode === 0;
}

export async function countCommitsBetween(cwd: string, goodSha: string, badSha: string): Promise<number> {
  const res = await runGit(["rev-list", "--count", `${goodSha}..${badSha}`], cwd);
  if (res.exitCode !== 0) return 0;
  const count = Number.parseInt(res.stdout, 10);
  return Number.isFinite(count) ? count : 0;
}

export async function getFirstParentSha(cwd: string, commitSha: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "--verify", `${commitSha}^1^{commit}`], cwd);
  if (res.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(res.stdout)) {
    return null;
  }
  return res.stdout.toLowerCase();
}

export async function isBisectActive(cwd: string): Promise<boolean> {
  try {
    const bisectStartPath = await resolveGitPath(cwd, "BISECT_START");
    return existsSync(bisectStartPath);
  } catch {
    return false;
  }
}

export async function runGitDoctor(targetPath = "."): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];
  const resolvedTarget = path.resolve(targetPath);

  const verCheck = await checkGitVersion();
  checks.push({
    id: "git_version",
    ok: verCheck.ok,
    severity: verCheck.ok ? "info" : "error",
    summary: verCheck.version
      ? `Git ${verCheck.version.raw} (${verCheck.ok ? "supported >= 2.36" : "unsupported < 2.36"})`
      : `Git unavailable: ${verCheck.rawOutput}`,
    ...(verCheck.ok
      ? {}
      : {
          remediation:
            "Upgrade Git to 2.36 or newer (required for safe exit code 126/127 handling and worktree bisect state).",
        }),
  });

  const statusProbe = await runGit(["status", "--porcelain"], resolvedTarget);
  if (statusProbe.stderr.includes("dubious ownership")) {
    checks.push({
      id: "safe_directory",
      ok: false,
      severity: "error",
      summary: `Git rejected repository ownership for ${resolvedTarget}`,
      remediation: `Run manually: git config --global --add safe.directory ${resolvedTarget}`,
    });
    return {
      ok: false,
      gitVersion: verCheck.version?.raw ?? null,
      repoRoot: null,
      commonGitDir: null,
      checks,
    };
  }

  checks.push({
    id: "safe_directory",
    ok: true,
    severity: "info",
    summary: "Repository ownership accepted by Git safe.directory policy",
  });

  let repoRoot: string | null = null;
  let commonGitDir: string | null = null;
  try {
    repoRoot = await resolveRepoRoot(resolvedTarget);
    commonGitDir = await resolveCommonGitDir(resolvedTarget);
    checks.push({
      id: "git_repo",
      ok: true,
      severity: "info",
      summary: `Resolved Git repository at ${repoRoot}`,
    });
  } catch (err: unknown) {
    checks.push({
      id: "git_repo",
      ok: false,
      severity: "error",
      summary: (err as Error).message,
      remediation: "Run BisectPilot inside a valid Git working tree.",
    });
    return {
      ok: false,
      gitVersion: verCheck.version?.raw ?? null,
      repoRoot: null,
      commonGitDir: null,
      checks,
    };
  }

  const shallowRes = await runGit(["rev-parse", "--is-shallow-repository"], repoRoot);
  const isShallow = shallowRes.stdout.trim() === "true";
  checks.push({
    id: "shallow_repository",
    ok: !isShallow,
    severity: isShallow ? "warning" : "info",
    summary: isShallow ? "Repository is a shallow clone; historical endpoints may be missing" : "Full commit history present",
    ...(isShallow ? { remediation: "Run `git fetch --unshallow` before bisecting across older commits." } : {}),
  });

  const activeBisect = await isBisectActive(repoRoot);
  checks.push({
    id: "active_bisect",
    ok: true,
    severity: activeBisect ? "warning" : "info",
    summary: activeBisect
      ? "Main checkout has an active git bisect (BisectPilot uses an isolated worktree and will not disturb it)"
      : "No active git bisect in main checkout",
  });

  const gitattributesPath = path.join(repoRoot, ".gitattributes");
  const hasLfs =
    existsSync(gitattributesPath) &&
    (await runGit(["grep", "-q", "filter=lfs", "--", ".gitattributes"], repoRoot)).exitCode === 0;
  checks.push({
    id: "git_lfs",
    ok: true,
    severity: hasLfs ? "warning" : "info",
    summary: hasLfs ? "Git LFS attributes detected; ensure git-lfs is installed" : "No Git LFS filters detected",
  });

  const hasSubmodules = existsSync(path.join(repoRoot, ".gitmodules"));
  checks.push({
    id: "submodules",
    ok: true,
    severity: hasSubmodules ? "warning" : "info",
    summary: hasSubmodules ? "Submodules (.gitmodules) detected" : "No submodules detected",
  });

  const sparseRes = await runGit(["config", "--bool", "core.sparseCheckout"], repoRoot);
  const isSparse = sparseRes.stdout.trim() === "true";
  checks.push({
    id: "sparse_checkout",
    ok: true,
    severity: isSparse ? "warning" : "info",
    summary: isSparse ? "Sparse checkout enabled" : "Sparse checkout not enabled",
  });

  const overallOk = checks.every((c) => c.severity !== "error" || c.ok);
  return {
    ok: overallOk,
    gitVersion: verCheck.version?.raw ?? null,
    repoRoot,
    commonGitDir,
    checks,
  };
}
