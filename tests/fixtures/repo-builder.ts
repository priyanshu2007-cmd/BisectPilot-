import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRefToSha, runGit } from "../../src/git/index.js";

export interface CommitStepSpec {
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface GeneratedFixtureRepo {
  readonly tmpRoot: string;
  readonly repoDir: string;
  readonly commitShas: readonly string[];
  cleanup(): void;
}

export async function buildFixtureRepo(
  steps: readonly CommitStepSpec[],
  prefix = "bp-fixture-"
): Promise<GeneratedFixtureRepo> {
  const rawTmpRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmpRoot = (realpathSync.native ?? realpathSync)(rawTmpRoot);
  const repoDir = path.join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });

  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Fixture Builder"], repoDir);
  await runGit(["config", "user.email", "fixture@example.com"], repoDir);

  const commitShas: string[] = [];
  for (const step of steps) {
    for (const [relPath, content] of Object.entries(step.files)) {
      const fullPath = path.join(repoDir, relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }
    await runGit(["add", "-A"], repoDir);
    await runGit(["commit", "-m", step.message], repoDir);
    commitShas.push(await resolveRefToSha(repoDir, "HEAD"));
  }

  return {
    tmpRoot,
    repoDir,
    commitShas,
    cleanup() {
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
