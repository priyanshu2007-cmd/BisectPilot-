import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  LocalBisectEngine,
  readLedgerEvents,
  resolveRefToSha,
  runGit,
  type BisectConfigV1,
} from "../../src/index.js";

async function createMonorepoFixture(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
  readonly plantedApiBadSha: string;
}> {
  const repoDir = path.join(tmpRoot, "monorepo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Monorepo Bot"], repoDir);
  await runGit(["config", "user.email", "mono@example.com"], repoDir);

  const shas: string[] = [];

  // Commit 1: Initial monorepo setup with api and ui packages
  writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "my-monorepo", workspaces: ["packages/*"], version: "1.0.0" }, null, 2),
    "utf-8"
  );
  writeFileSync(path.join(repoDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }), "utf-8");

  mkdirSync(path.join(repoDir, "packages", "api"), { recursive: true });
  mkdirSync(path.join(repoDir, "packages", "ui"), { recursive: true });

  writeFileSync(
    path.join(repoDir, "packages", "api", "index.mjs"),
    "export const status = 200;\n",
    "utf-8"
  );
  writeFileSync(
    path.join(repoDir, "packages", "api", "check.mjs"),
    'import { status } from "./index.mjs";\nprocess.exit(status === 200 ? 0 : 1);\n',
    "utf-8"
  );

  writeFileSync(
    path.join(repoDir, "packages", "ui", "index.mjs"),
    "export const component = 'Button';\n",
    "utf-8"
  );

  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C1: initial monorepo setup"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 2: UI-only change (unrelated to api)
  writeFileSync(
    path.join(repoDir, "packages", "ui", "index.mjs"),
    "export const component = 'ButtonV2';\n",
    "utf-8"
  );
  await runGit(["add", "packages/ui/index.mjs"], repoDir);
  await runGit(["commit", "-m", "C2: update ui button component"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 3: API regression introduced (PLANTED BUG)
  writeFileSync(
    path.join(repoDir, "packages", "api", "index.mjs"),
    "export const status = 500;\n",
    "utf-8"
  );
  await runGit(["add", "packages/api/index.mjs"], repoDir);
  await runGit(["commit", "-m", "C3: api regression breaking status endpoint"], repoDir);
  const plantedApiBadSha = await resolveRefToSha(repoDir, "HEAD");
  shas.push(plantedApiBadSha);

  // Commit 4: UI-only change (unrelated to api)
  writeFileSync(
    path.join(repoDir, "packages", "ui", "index.mjs"),
    "export const component = 'ButtonV3';\n",
    "utf-8"
  );
  await runGit(["add", "packages/ui/index.mjs"], repoDir);
  await runGit(["commit", "-m", "C4: update ui to button v3"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  return { repoDir, shas, plantedApiBadSha };
}

describe("Step 7 — Monorepo & Multi-Package Workspace Bisection Integration", () => {
  it("isolates package-scoped regression without disturbance from unrelated package commits", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-mono-test-"));
    try {
      const { repoDir, shas, plantedApiBadSha } = await createMonorepoFixture(tmpRoot);
      const sessionsRoot = path.join(tmpRoot, "sessions");

      const engine = new LocalBisectEngine();

      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: "packages/api",
        goodRef: shas[0]!,
        badRef: shas[3]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: ["check.mjs"],
            timeoutMs: 30000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
        },
        sessionRootDir: sessionsRoot,
      };

      // 1. Plan
      const plan = await engine.plan(config);
      assert.equal(plan.ok, true);
      assert.ok(plan.warnings.some((w) => w.includes("Workspace mode active")));

      // 2. Start bisection
      const manifest = await engine.start(config);
      assert.equal(manifest.state, "concluded");
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, plantedApiBadSha);

      // Verify session artifacts recorded working directory
      const reportJsonPath = path.join(manifest.sessionDir, "report.json");
      assert.ok(existsSync(reportJsonPath));
      const reportJson = JSON.parse(readFileSync(reportJsonPath, "utf-8"));
      assert.equal(reportJson.workingDirectory, "packages/api");
      assert.ok(Array.isArray(reportJson.pathScope));
      assert.ok(reportJson.pathScope.includes("packages/api"));

      // Verify repro script runs from packages/api
      const reproScriptPath = path.join(manifest.sessionDir, "repro.sh");
      assert.ok(existsSync(reproScriptPath));
      const reproContent = readFileSync(reproScriptPath, "utf-8");
      assert.ok(reproContent.includes('Target Workspace: packages/api'));
      assert.ok(reproContent.includes('packages/api'));

      // Execute repro.sh to confirm standalone reproduction contract
      const reproOutput = execFileSync("bash", [reproScriptPath], { encoding: "utf-8" });
      assert.ok(reproOutput.includes("parent: good, candidate: bad"));

      // Verify ledger records lockfile & workspace hashes
      const events = readLedgerEvents(manifest.ledgerPath);
      const classifiedEvents = events.filter((e) => e.type === "revision_classified");
      assert.ok(classifiedEvents.length > 0);
      for (const ev of classifiedEvents) {
        if ("toolchainInfo" in ev && ev.toolchainInfo) {
          assert.equal(ev.toolchainInfo.workspaceRelPath, "packages/api");
          assert.equal(ev.toolchainInfo.rootLockfileName, "package-lock.json");
          assert.ok(ev.toolchainInfo.rootLockfileHash);
        }
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("detects root-level shared dependency change that breaks package", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-mono-rootdep-"));
    try {
      const repoDir = path.join(tmpRoot, "monorepo");
      mkdirSync(repoDir, { recursive: true });
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Monorepo Bot"], repoDir);
      await runGit(["config", "user.email", "mono@example.com"], repoDir);

      mkdirSync(path.join(repoDir, "packages", "service"), { recursive: true });

      // C1: good root config (dep version 1)
      writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify({ name: "root", dependencies: { sharedDep: "1.0.0" } }, null, 2),
        "utf-8"
      );
      // Service checks root package.json dependency version
      writeFileSync(
        path.join(repoDir, "packages", "service", "check.mjs"),
        `import fs from 'node:fs';\nconst rootPkg = JSON.parse(fs.readFileSync('../../package.json', 'utf-8'));\nprocess.exit(rootPkg.dependencies?.sharedDep === '1.0.0' ? 0 : 1);\n`,
        "utf-8"
      );
      await runGit(["add", "."], repoDir);
      await runGit(["commit", "-m", "C1: initial with sharedDep 1.0.0"], repoDir);
      const goodSha = await resolveRefToSha(repoDir, "HEAD");

      // C2: Root dependency bumped to 2.0.0 (breaking service!)
      writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify({ name: "root", dependencies: { sharedDep: "2.0.0" } }, null, 2),
        "utf-8"
      );
      await runGit(["add", "package.json"], repoDir);
      await runGit(["commit", "-m", "C2: root bump sharedDep to 2.0.0 (breaking)"], repoDir);
      const badSha = await resolveRefToSha(repoDir, "HEAD");

      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: "packages/service",
        goodRef: goodSha,
        badRef: badSha,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: ["check.mjs"],
            timeoutMs: 30000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const manifest = await engine.start(config);
      assert.equal(manifest.state, "concluded");
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, badSha);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("safely skips historical revisions where workspace directory did not yet exist", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-mono-untestable-"));
    try {
      const repoDir = path.join(tmpRoot, "monorepo");
      mkdirSync(repoDir, { recursive: true });
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Monorepo Bot"], repoDir);
      await runGit(["config", "user.email", "mono@example.com"], repoDir);

      // C0: root only, packages/new-pkg does not exist
      writeFileSync(path.join(repoDir, "README.md"), "# Monorepo\n", "utf-8");
      await runGit(["add", "README.md"], repoDir);
      await runGit(["commit", "-m", "C0: monorepo before new-pkg existed"], repoDir);
      const c0Sha = await resolveRefToSha(repoDir, "HEAD");

      // C1: new-pkg created (good)
      mkdirSync(path.join(repoDir, "packages", "new-pkg"), { recursive: true });
      writeFileSync(
        path.join(repoDir, "packages", "new-pkg", "check.mjs"),
        "process.exit(0);\n",
        "utf-8"
      );
      await runGit(["add", "."], repoDir);
      await runGit(["commit", "-m", "C1: create new-pkg"], repoDir);
      const c1Sha = await resolveRefToSha(repoDir, "HEAD");

      // C2: new-pkg broken (bad)
      writeFileSync(
        path.join(repoDir, "packages", "new-pkg", "check.mjs"),
        "process.exit(1);\n",
        "utf-8"
      );
      await runGit(["add", "."], repoDir);
      await runGit(["commit", "-m", "C2: break new-pkg"], repoDir);
      const c2Sha = await resolveRefToSha(repoDir, "HEAD");

      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: "packages/new-pkg",
        goodRef: c0Sha,
        badRef: c2Sha,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: ["check.mjs"],
            timeoutMs: 30000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      // Since C0 does not have packages/new-pkg, evaluating C0 would skip it as untestable_revision
      const manifest = await engine.start(config);
      assert.ok(manifest.state === "concluded");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CLI supports --cwd and rejects path traversal escaping repo root", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-cli-mono-"));
    try {
      const { repoDir, shas } = await createMonorepoFixture(tmpRoot);
      const cfgPath = path.join(tmpRoot, "test-config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            profile: "functional",
            repositoryRoot: repoDir,
            workingDirectory: ".",
            goodRef: shas[0],
            badRef: shas[3],
            oracle: {
              mode: "in-tree",
              command: {
                command: process.execPath,
                args: ["check.mjs"],
                timeoutMs: 30000,
              },
            },
            execution: {
              ...DEFAULT_EXECUTION_POLICY,
              confirmBeforeExecutingCode: false,
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      const cliPath = path.resolve("./dist/src/index.js");

      // Valid --cwd plan
      const planRes = execFileSync(
        process.execPath,
        [cliPath, "plan", "--config", cfgPath, "--cwd", "packages/api"],
        { encoding: "utf-8" }
      );
      assert.ok(planRes.includes('"ok": true'));
      assert.ok(planRes.includes("Workspace mode active"));

      // Path traversal attempt should fail with code 2
      let failed = false;
      try {
        execFileSync(
          process.execPath,
          [cliPath, "plan", "--config", cfgPath, "--cwd", "../../escaped"],
          { encoding: "utf-8", stdio: "pipe" }
        );
      } catch (err: any) {
        failed = true;
        assert.equal(err.status, 2);
        assert.ok(err.stderr.includes("escapes the repository root"));
      }
      assert.equal(failed, true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
