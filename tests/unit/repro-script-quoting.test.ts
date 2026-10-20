import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { DEFAULT_EXECUTION_POLICY, validateConfig, type BisectConfigV1 } from "../../src/contracts/config.js";
import { generateReproScript } from "../../src/reports/index.js";
import { buildFixtureRepo, type GeneratedFixtureRepo } from "../fixtures/repo-builder.js";
import type { SessionManifestV1 } from "../../src/contracts/session.js";

function createTmpDir(): string {
  const dir = path.join(os.tmpdir(), `bp-repro-quote-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("Repro Script Shell Quoting and Path Validation Suite", async (t) => {
  let tmpDir: string;
  let fixture: GeneratedFixtureRepo | undefined;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  await t.test("validateConfig rejects workingDirectory and overlayFiles with control characters or newlines", () => {
    const baseConfig: BisectConfigV1 = {
      schemaVersion: 1,
      profile: "functional",
      repositoryRoot: tmpDir,
      workingDirectory: ".",
      goodRef: "good",
      badRef: "bad",
      oracle: {
        mode: "in-tree",
        command: { command: "true", args: [], timeoutMs: 1000 },
      },
      execution: DEFAULT_EXECUTION_POLICY,
    };

    const resNewlineWorkDir = validateConfig({
      ...baseConfig,
      workingDirectory: "pkg\nid #",
    });
    assert.strictEqual(resNewlineWorkDir.ok, false, "validateConfig must reject workingDirectory with newline");

    const resNewlineOverlay = validateConfig({
      ...baseConfig,
      oracle: {
        mode: "overlay",
        command: { command: "true", args: [], timeoutMs: 1000 },
        overlayFiles: ["test\nfile.js"],
      },
    });
    assert.strictEqual(resNewlineOverlay.ok, false, "validateConfig must reject overlayFiles with newline");
  });

  await t.test("generateReproScript properly quotes hostile overlay files and working directories", () => {
    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_hostile_quote",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "concluded",
      sessionDir: tmpDir,
      ledgerPath: path.join(tmpDir, "ledger.jsonl"),
      repository: {
        rootPath: tmpDir,
        commonGitDir: path.join(tmpDir, ".git"),
        originalHead: "badsha0001",
        originalWasDirty: false,
        worktreePath: tmpDir,
        createdByTool: true,
      },
      bounds: {
        goodInputRef: "good",
        goodSha: "goodsha0001",
        badInputRef: "bad",
        badSha: "badsha0001",
      },
      configHash: "hash123",
      config: {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: tmpDir,
        workingDirectory: "pkg\nid #",
        goodRef: "good",
        badRef: "bad",
        oracle: {
          mode: "overlay",
          command: { command: "sh", args: ["-c", "exit 0"], timeoutMs: 1000 },
          overlayFiles: ["t/$(id).js"],
        },
        execution: DEFAULT_EXECUTION_POLICY,
      },
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [],
      runnerVersion: "0.1.0",
      conclusion: {
        outcome: "candidate_confirmed",
        candidateSha: "badsha0001",
        parentSha: "goodsha0001",
        skippedShas: [],
        explanation: "Confirmed",
      },
    };

    const script = generateReproScript(manifest);

    // Assert (a): contains no unquoted $(
    assert.doesNotMatch(script, /"\$TMP_WT\/.*?\$\(/, "Must not contain unquoted $( inside double quotes");
    assert.ok(script.includes("'t/$(id).js'"), "Overlay file should be quoted with single quotes");

    // Assert comment does not contain unescaped newline
    const commentLines = script.split("\n").filter((l) => l.startsWith("#"));
    for (const c of commentLines) {
      assert.doesNotMatch(c, /\n|\r/, "Comments must not contain raw newlines");
    }
    // Also assert 'id #' does not appear as an executable command line outside comments
    const executableLines = script.split("\n").filter((l) => !l.startsWith("#") && l.trim().length > 0);
    assert.strictEqual(
      executableLines.some((l) => l.trim() === "id #"),
      false,
      "id # must not break out of comments into shell commands"
    );

    // Assert (b): bash -n passes
    if (process.platform !== "win32") {
      const scriptPath = path.join(tmpDir, "repro.sh");
      writeFileSync(scriptPath, script, "utf-8");
      execSync(`bash -n "${scriptPath}"`);
    }
  });

  await t.test("end-to-end: run generated repro.sh on fixture repo with overlay file containing space and $", async () => {
    if (process.platform === "win32") return;

    fixture = await buildFixtureRepo([
      { message: "Good commit", files: { "app.txt": "good\n" } },
      { message: "Bad commit", files: { "app.txt": "bad\n" } },
    ]);

    const sessionDir = path.join(tmpDir, "session_e2e_repro");
    mkdirSync(sessionDir, { recursive: true });
    const overlaysDir = path.join(sessionDir, "overlays");
    mkdirSync(overlaysDir, { recursive: true });

    // Overlay file with space and $
    const overlayRelName = "test $ space.js";
    writeFileSync(path.join(overlaysDir, overlayRelName), "// overlay content\n", "utf-8");

    const manifest: SessionManifestV1 = {
      schemaVersion: 1,
      id: "session_e2e_repro",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "concluded",
      sessionDir,
      ledgerPath: path.join(sessionDir, "ledger.jsonl"),
      repository: {
        rootPath: fixture.repoDir,
        commonGitDir: path.join(fixture.repoDir, ".git"),
        originalHead: fixture.commitShas[1]!,
        originalWasDirty: false,
        worktreePath: fixture.repoDir,
        createdByTool: true,
      },
      bounds: {
        goodInputRef: fixture.commitShas[0]!,
        goodSha: fixture.commitShas[0]!,
        badInputRef: fixture.commitShas[1]!,
        badSha: fixture.commitShas[1]!,
      },
      configHash: "hash123",
      config: {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: fixture.repoDir,
        workingDirectory: ".",
        goodRef: fixture.commitShas[0]!,
        badRef: fixture.commitShas[1]!,
        oracle: {
          mode: "overlay",
          command: {
            command: "sh",
            args: ["-c", 'grep -q "good" app.txt && [ -f "test $ space.js" ]'],
            timeoutMs: 5000,
          },
          overlayFiles: [overlayRelName],
        },
        execution: DEFAULT_EXECUTION_POLICY,
      },
      overlayHashes: {},
      skipCount: 0,
      testedRevisions: [],
      runnerVersion: "0.1.0",
      conclusion: {
        outcome: "candidate_confirmed",
        candidateSha: fixture.commitShas[1]!,
        parentSha: fixture.commitShas[0]!,
        skippedShas: [],
        explanation: "Confirmed",
      },
    };

    const script = generateReproScript(manifest);
    const scriptPath = path.join(sessionDir, "repro.sh");
    writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    const stdout = execSync(`bash "${scriptPath}"`, { encoding: "utf-8" });
    assert.match(stdout, /parent:\s*good,\s*candidate:\s*bad/);
  });
});
