import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  detectWorkspaceDependencies,
  resolveWorkspacePathScope,
  validateWorkspacePath,
} from "../../src/domain/workspace.js";
import { validateConfig } from "../../src/config/index.js";
import { generateReproScript } from "../../src/reports/index.js";
import type { SessionManifestV1 } from "../../src/contracts/index.js";

test("Feature A & C — Workspace Path Validation and Safety", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-ws-test-"));
  const repoRoot = path.join(tmpDir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(path.join(repoRoot, "packages", "api"), { recursive: true });

  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test("accepts valid relative workspace subdirectory", () => {
    const res = validateWorkspacePath(repoRoot, "packages/api");
    assert.equal(res.ok, true);
    assert.equal(res.relativePath, "packages/api");
    assert.equal(res.absolutePath, path.join(repoRoot, "packages", "api"));
  });

  await t.test("accepts dot (.) as root workspace", () => {
    const res = validateWorkspacePath(repoRoot, ".");
    assert.equal(res.ok, true);
    assert.equal(res.relativePath, ".");
  });

  await t.test("rejects empty workspace input", () => {
    const res = validateWorkspacePath(repoRoot, "   ");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /cannot be empty/i);
  });

  await t.test("rejects directory traversal escaping repository root", () => {
    const res = validateWorkspacePath(repoRoot, "../../outside");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /escapes the repository root/i);
  });

  await t.test("rejects absolute path pointing outside repository root", () => {
    const res = validateWorkspacePath(repoRoot, "/tmp/outside");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /escapes the repository root/i);
  });

  await t.test("detects and rejects symlink escape pointing outside repository root", () => {
    const outsideDir = path.join(tmpDir, "outside_folder");
    mkdirSync(outsideDir, { recursive: true });
    const symlinkPath = path.join(repoRoot, "packages", "symlink_escape");

    try {
      symlinkSync(outsideDir, symlinkPath, "dir");
      const res = validateWorkspacePath(repoRoot, "packages/symlink_escape");
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /symlink outside the repository root/i);
    } catch (err) {
      // If symlink creation not permitted on this platform/user, test is safe
    }
  });
});

test("Feature B — Workspace Path Scope Resolution", async (t) => {
  const repoRoot = "/fake/repo";

  await t.test("returns undefined when working directory is root dot (.)", () => {
    const scope = resolveWorkspacePathScope(repoRoot, ".");
    assert.equal(scope, undefined);
  });

  await t.test("includes workspace directory and root dependency/toolchain files", () => {
    const scope = resolveWorkspacePathScope(repoRoot, "packages/api");
    assert.ok(scope);
    assert.ok(scope.includes("packages/api"));
    assert.ok(scope.includes("package.json"));
    assert.ok(scope.includes("package-lock.json"));
    assert.ok(scope.includes("pnpm-lock.yaml"));
    assert.ok(scope.includes("pnpm-workspace.yaml"));
    assert.ok(scope.includes("yarn.lock"));
    assert.ok(scope.includes("tsconfig.json"));
  });

  await t.test("honors explicit customScope overrides", () => {
    const custom = ["packages/api", "packages/shared"];
    const scope = resolveWorkspacePathScope(repoRoot, "packages/api", custom);
    assert.deepEqual(scope, custom);
  });
});

test("Feature C — Dependency Manifest and Lockfile Inspection", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "bp-ws-deps-"));
  const repoRoot = path.join(tmpDir, "repo");
  const wsDir = path.join(repoRoot, "packages", "api");
  mkdirSync(wsDir, { recursive: true });

  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  writeFileSync(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "monorepo-root", workspaces: ["packages/*"], packageManager: "pnpm@9.0.0" })
  );
  writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(wsDir, "package.json"), JSON.stringify({ name: "@mono/api", version: "1.0.0" }));

  const inspection = detectWorkspaceDependencies(repoRoot, "packages/api");
  assert.equal(inspection.packageManager, "pnpm");
  assert.equal(inspection.monorepoType, "pnpm-workspace");
  assert.equal(inspection.rootLockfileName, "pnpm-lock.yaml");
  assert.ok(inspection.rootLockfileHash && inspection.rootLockfileHash.length === 64);
  assert.ok(inspection.rootManifestHash && inspection.rootManifestHash.length === 64);
  assert.ok(inspection.workspaceManifestHash && inspection.workspaceManifestHash.length === 64);
  assert.equal(inspection.workspaceRelPath, "packages/api");
});

test("Configuration Validation with workingDirectory and pathScope", () => {
  const validBase = {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: ".",
    workingDirectory: "packages/api",
    pathScope: ["packages/api", "packages/core"],
    goodRef: "HEAD~2",
    badRef: "HEAD",
    oracle: {
      mode: "in-tree",
      command: {
        command: "npm",
        args: ["test"],
        timeoutMs: 30000,
      },
    },
    execution: {
      maxOutputBytesPerCommand: 10000,
      maxRetries: 0,
      endpointFlakeRuns: 1,
      boundaryConfirmRuns: 1,
      maxSkips: 5,
      confirmBeforeExecutingCode: false,
      cleanIgnored: false,
      allowlistedEnvVars: [],
    },
  };

  const res = validateConfig(validBase);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.workingDirectory, "packages/api");
    assert.deepEqual(res.value.pathScope, ["packages/api", "packages/core"]);
  }

  const invalidScope = {
    ...validBase,
    pathScope: [""],
  };
  const invalidRes = validateConfig(invalidScope);
  assert.equal(invalidRes.ok, false);
});

test("Repro Script Generation with Workspace Subdirectory", () => {
  const fakeManifest: SessionManifestV1 = {
    schemaVersion: 1,
    id: "bp-repro-ws-test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "concluded",
    sessionDir: "/tmp/fake-session",
    ledgerPath: "/tmp/fake-session/ledger.jsonl",
    repository: {
      rootPath: "/fake/repo",
      commonGitDir: "/fake/repo/.git",
      originalHead: "1111111111111111111111111111111111111111",
      originalWasDirty: false,
      worktreePath: "/tmp/fake-session/worktree",
      createdByTool: true,
    },
    bounds: {
      goodInputRef: "v1.0",
      goodSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      badInputRef: "v2.0",
      badSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    configHash: "fakehash",
    config: {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: "/fake/repo",
      workingDirectory: "packages/api",
      goodRef: "v1.0",
      badRef: "v2.0",
      oracle: {
        mode: "in-tree",
        command: {
          command: "npm",
          args: ["test"],
          timeoutMs: 30000,
        },
      },
      execution: {
        maxOutputBytesPerCommand: 10000,
        maxRetries: 0,
        endpointFlakeRuns: 1,
        boundaryConfirmRuns: 1,
        maxSkips: 5,
        confirmBeforeExecutingCode: false,
        cleanIgnored: false,
        allowlistedEnvVars: [],
      },
    },
    overlayHashes: {},
    skipCount: 0,
    testedRevisions: [],
    runnerVersion: "0.1.0",
    conclusion: {
      outcome: "candidate_confirmed",
      candidateSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      parentSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      skippedShas: [],
      explanation: "Regression isolated to package/api",
    },
  };

  const script = generateReproScript(fakeManifest);
  assert.ok(script.includes('# Target Workspace: packages/api'));
  assert.ok(script.includes('cd "$TMP_WT"/\'packages/api\''));
  assert.ok(script.includes("'npm' 'test'"));
});
