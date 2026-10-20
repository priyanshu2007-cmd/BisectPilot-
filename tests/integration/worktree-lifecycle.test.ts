import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  countCommitsBetween,
  getCurrentHead,
  isAncestor,
  isWorkingTreeDirty,
  resolveCommonGitDir,
  resolveRefToSha,
  resolveRepoRoot,
  runGit,
  runGitDoctor,
} from "../../src/adapters/git/git-client.js";
import {
  createSessionWorktree,
  removeOwnedWorktree,
  resetOwnedWorktree,
  verifyWorktreeOwnership,
} from "../../src/adapters/git/worktree-manager.js";

async function createTempRepo(): Promise<{
  readonly tmpRoot: string;
  readonly repoDir: string;
  readonly commits: readonly string[];
}> {
  const tmpRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "bp-a1-a2-")));
  const repoDir = path.join(tmpRoot, "repo");
  mkdirSyncSafe(repoDir);
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Test Bot"], repoDir);
  await runGit(["config", "user.email", "bot@example.com"], repoDir);

  const commits: string[] = [];
  for (let i = 1; i <= 4; i++) {
    writeFileSync(path.join(repoDir, "app.txt"), `line ${i}\n`, "utf-8");
    await runGit(["add", "app.txt"], repoDir);
    await runGit(["commit", "-m", `commit ${i}`], repoDir);
    const sha = await resolveRefToSha(repoDir, "HEAD");
    commits.push(sha);
  }
  return { tmpRoot, repoDir, commits };
}

function mkdirSyncSafe(p: string): void {
  mkdirSync(p, { recursive: true });
}

describe("A1 & A2 — Real Git Adapter & Guarded Worktree Lifecycle", () => {
  it("resolves refs, ancestry, commit counts, and doctor checks on a real temp repo", async () => {
    const tmpRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "bp-a1-")));
    const repoDir = path.join(tmpRoot, "repo");
    const fs = await import("node:fs");
    fs.mkdirSync(repoDir, { recursive: true });
    try {
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Test Bot"], repoDir);
      await runGit(["config", "user.email", "bot@example.com"], repoDir);

      const shas: string[] = [];
      for (let i = 1; i <= 3; i++) {
        writeFileSync(path.join(repoDir, "file.txt"), `v${i}\n`, "utf-8");
        await runGit(["add", "file.txt"], repoDir);
        await runGit(["commit", "-m", `c${i}`], repoDir);
        shas.push(await resolveRefToSha(repoDir, "HEAD"));
      }

      const root = await resolveRepoRoot(repoDir);
      assert.equal(fs.realpathSync.native(root), fs.realpathSync.native(repoDir));
      assert.equal(await isAncestor(repoDir, shas[0]!, shas[2]!), true);
      assert.equal(await isAncestor(repoDir, shas[2]!, shas[0]!), false);
      assert.equal(await countCommitsBetween(repoDir, shas[0]!, shas[2]!), 2);

      const doc = await runGitDoctor(repoDir);
      assert.equal(doc.ok, true);
      assert.ok(doc.checks.some((c) => c.id === "git_version" && c.ok));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("preserves original HEAD, staged index, tracked edits, and untracked files across worktree create/reset/remove and refuses unowned paths", async () => {
    const tmpRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "bp-a2-")));
    const repoDir = path.join(tmpRoot, "repo");
    const sessionDir = path.join(tmpRoot, "session-01");
    const worktreeDir = path.join(sessionDir, "worktree");
    const fs = await import("node:fs");
    fs.mkdirSync(repoDir, { recursive: true });

    try {
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Test Bot"], repoDir);
      await runGit(["config", "user.email", "bot@example.com"], repoDir);

      writeFileSync(path.join(repoDir, "tracked.txt"), "v1\n", "utf-8");
      writeFileSync(path.join(repoDir, "staged.txt"), "initial\n", "utf-8");
      await runGit(["add", "."], repoDir);
      await runGit(["commit", "-m", "c1"], repoDir);
      const c1 = await resolveRefToSha(repoDir, "HEAD");

      writeFileSync(path.join(repoDir, "tracked.txt"), "v2\n", "utf-8");
      await runGit(["add", "tracked.txt"], repoDir);
      await runGit(["commit", "-m", "c2"], repoDir);
      const c2 = await resolveRefToSha(repoDir, "HEAD");

      // Dirty the user's original checkout: staged change, unstaged tracked edit, and untracked file
      writeFileSync(path.join(repoDir, "staged.txt"), "staged-modification\n", "utf-8");
      await runGit(["add", "staged.txt"], repoDir);
      writeFileSync(path.join(repoDir, "tracked.txt"), "unstaged-user-edit\n", "utf-8");
      writeFileSync(path.join(repoDir, "untracked-user.txt"), "precious-untracked\n", "utf-8");

      assert.equal(await isWorkingTreeDirty(repoDir), true);
      const originalHead = await getCurrentHead(repoDir);
      const commonGitDir = await resolveCommonGitDir(repoDir);

      const repoMeta = await createSessionWorktree({
        sessionId: "sess-a2",
        repoRoot: repoDir,
        commonGitDir,
        originalHead,
        originalWasDirty: true,
        worktreePath: worktreeDir,
        initialCommitSha: c1,
      });

      const manifestStub = { id: "sess-a2", repository: repoMeta };

      // Mutate tracked and untracked files in the tool-owned worktree
      writeFileSync(path.join(repoMeta.worktreePath, "tracked.txt"), "polluted-by-build\n", "utf-8");
      writeFileSync(path.join(repoMeta.worktreePath, "overlay-test.js"), "console.log(1)\n", "utf-8");

      await resetOwnedWorktree(manifestStub, { overlayRelativePaths: ["overlay-test.js"] });
      assert.equal(readFileSync(path.join(repoMeta.worktreePath, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"), "v1\n");
      assert.equal(existsSync(path.join(repoMeta.worktreePath, "overlay-test.js")), false);

      // Guard must refuse resetting or deleting the original repository root or an arbitrary folder
      await assert.rejects(
        () => verifyWorktreeOwnership(manifestStub, repoDir),
        /Refusing destructive operation on original repository checkout/
      );
      await assert.rejects(
        () => verifyWorktreeOwnership({ id: "wrong-id", repository: repoMeta }, repoMeta.worktreePath),
        /Ownership marker mismatch/
      );

      // Dry-run removal leaves worktree intact
      const dryRes = await removeOwnedWorktree(manifestStub, { dryRun: true });
      assert.equal(dryRes.removed, false);
      assert.equal(existsSync(repoMeta.worktreePath), true);

      // Real removal cleans up worktree
      const remRes = await removeOwnedWorktree(manifestStub, { dryRun: false });
      assert.equal(remRes.removed, true);
      assert.equal(existsSync(repoMeta.worktreePath), false);

      // Verify user's original checkout is 100% untouched
      assert.equal(await getCurrentHead(repoDir), c2);
      assert.equal(readFileSync(path.join(repoDir, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"), "unstaged-user-edit\n");
      assert.equal(readFileSync(path.join(repoDir, "staged.txt"), "utf-8").replace(/\r\n/g, "\n"), "staged-modification\n");
      assert.equal(readFileSync(path.join(repoDir, "untracked-user.txt"), "utf-8").replace(/\r\n/g, "\n"), "precious-untracked\n");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("excludes .bisectpilot/ from target repo status idempotently without touching tracked files or existing exclude rules", async () => {
    const tmpRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "bp-exclude-")));
    const repoDir = path.join(tmpRoot, "repo");
    const sessionDir = path.join(repoDir, ".bisectpilot", "sessions", "sess-ex-1");
    const worktreeDir = path.join(sessionDir, "worktree");

    mkdirSyncSafe(repoDir);
    try {
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Test Bot"], repoDir);
      await runGit(["config", "user.email", "bot@example.com"], repoDir);

      writeFileSync(path.join(repoDir, "app.txt"), "hello\n", "utf-8");
      await runGit(["add", "app.txt"], repoDir);
      await runGit(["commit", "-m", "initial"], repoDir);
      const headSha = await resolveRefToSha(repoDir, "HEAD");

      const commonGitDir = await resolveCommonGitDir(repoDir);
      const excludeFile = path.join(commonGitDir, "info", "exclude");

      // Seed pre-existing exclude rules
      mkdirSyncSafe(path.dirname(excludeFile));
      writeFileSync(excludeFile, "# existing rules\n*.custom-ignore\n", "utf-8");

      // Create session 1 worktree
      const repoMeta1 = await createSessionWorktree({
        sessionId: "sess-ex-1",
        repoRoot: repoDir,
        commonGitDir,
        originalHead: headSha,
        originalWasDirty: false,
        worktreePath: worktreeDir,
        initialCommitSha: headSha,
      });

      // Write session files into .bisectpilot/
      writeFileSync(path.join(sessionDir, "manifest.json"), "{}", "utf-8");

      // Check git status --porcelain in target repo: .bisectpilot/ must NOT appear
      const statusRes1 = await runGit(["status", "--porcelain"], repoDir);
      assert.equal(statusRes1.stdout.trim(), "");

      // Check exclude file content: pre-existing rules preserved, .bisectpilot/ appended
      const excludeContent1 = readFileSync(excludeFile, "utf-8");
      assert.ok(excludeContent1.includes("# existing rules\n*.custom-ignore\n"));
      assert.ok(excludeContent1.includes(".bisectpilot/\n"));

      // Count occurrences of .bisectpilot in exclude file: must be exactly 1
      const count1 = (excludeContent1.match(/\.bisectpilot/g) || []).length;
      assert.equal(count1, 1);

      // Create session 2: must be idempotent, not duplicate exclude entry
      const sessionDir2 = path.join(repoDir, ".bisectpilot", "sessions", "sess-ex-2");
      const worktreeDir2 = path.join(sessionDir2, "worktree");
      await createSessionWorktree({
        sessionId: "sess-ex-2",
        repoRoot: repoDir,
        commonGitDir,
        originalHead: headSha,
        originalWasDirty: false,
        worktreePath: worktreeDir2,
        initialCommitSha: headSha,
      });

      const excludeContent2 = readFileSync(excludeFile, "utf-8");
      const count2 = (excludeContent2.match(/\.bisectpilot/g) || []).length;
      assert.equal(count2, 1, "Creating a second session must not duplicate .bisectpilot entry in exclude file");

      // Untracked .gitignore must not exist if not created by user
      assert.equal(existsSync(path.join(repoDir, ".gitignore")), false, "Must not create or modify tracked .gitignore");

      // Cleanup worktrees
      await removeOwnedWorktree({ id: "sess-ex-1", repository: repoMeta1 }, { dryRun: false });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
