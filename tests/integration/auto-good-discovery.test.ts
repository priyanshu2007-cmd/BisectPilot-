import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  LocalBisectEngine,
  generateJsonReport,
  generateMarkdownReport,
  readLedgerEvents,
  resolveRefToSha,
  runGit,
  type BisectConfigV1,
} from "../../src/index.js";

async function createDiscoveryTestRepo(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
}> {
  const repoDir = path.join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Test Bot"], repoDir);
  await runGit(["config", "user.email", "bot@example.com"], repoDir);

  const shas: string[] = [];
  // Commits 1..4 return 42 (good). Commits 5..8 return 99 (bad).
  for (let i = 1; i <= 8; i++) {
    const value = i >= 5 ? 99 : 42;
    writeFileSync(
      path.join(repoDir, "calc.mjs"),
      `export const answer = ${value};\nexport const step = ${i};\n`,
      "utf-8"
    );
    writeFileSync(
      path.join(repoDir, "test.mjs"),
      `import { answer } from "./calc.mjs";\nprocess.exit(answer === 42 ? 0 : 1);\n`,
      "utf-8"
    );
    await runGit(["add", "calc.mjs", "test.mjs"], repoDir);
    await runGit(["commit", "-m", `commit C${i}`], repoDir);
    shas.push(await resolveRefToSha(repoDir, "HEAD"));
  }

  // Tag commit C3 as v1.0.0
  await runGit(["tag", "v1.0.0", shas[2]!], repoDir);

  return { repoDir, shas };
}

describe("Feature A — Automatic Good-Endpoint Discovery (--good auto)", () => {
  it("discovers a good endpoint at the first candidate distance", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-disco-1-"));
    try {
      const { repoDir, shas } = await createDiscoveryTestRepo(tmpRoot);
      const engine = new LocalBisectEngine();
      // Bad commit is C5. First ancestor is C4 (which returns 42 -> good).
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: "auto",
        badRef: shas[4]!, // C5
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["test.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const plan = await engine.plan(config);
      assert.equal(plan.ok, true);
      assert.equal(plan.goodSha, "auto");

      const manifest = await engine.start(config);
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, shas[4]!);
      assert.equal(manifest.bounds.goodSha, shas[3]!); // Discovered C4 at distance 1
      assert.equal(manifest.bounds.goodInputRef, "auto");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("discovers a good endpoint through progressively larger commit distances", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-disco-exp-"));
    try {
      const { repoDir, shas } = await createDiscoveryTestRepo(tmpRoot);
      const engine = new LocalBisectEngine();
      // Bad commit is C8 (index 7). C7, C6, C5 are bad.
      // Distances from C8:
      // dist 1 = C7 (bad)
      // dist 2 = C6 (bad)
      // dist 4 = C4 (good) -> discovered!
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: "auto",
        badRef: shas[7]!, // C8
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["test.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const manifest = await engine.start(config);
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, shas[4]!); // First bad is C5
      assert.equal(manifest.bounds.goodInputRef, "auto");

      // Verify that ledger contains boundary checks for evaluated discovery candidates
      const events = readLedgerEvents(manifest.ledgerPath);
      const boundaryChecks = events.filter((e) => e.type === "boundary_check");
      assert.ok(boundaryChecks.length >= 1, "Expected boundary checks recorded for discovery");

      // Verify JSON report accurately reflects discovered bounds
      const jsonReport = generateJsonReport(manifest, events);
      assert.equal(jsonReport.outcome, "candidate_confirmed");
      assert.equal(jsonReport.candidateSha, shas[4]!);
      assert.equal(jsonReport.bounds.goodInputRef, "auto");

      const mdReport = generateMarkdownReport(manifest, events);
      assert.ok(mdReport.includes(shas[4]!.slice(0, 8)));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles a bad endpoint that cannot produce a valid good baseline (all ancestors bad)", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-disco-allbad-"));
    try {
      const repoDir = path.join(tmpRoot, "repo");
      mkdirSync(repoDir, { recursive: true });
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Test Bot"], repoDir);
      await runGit(["config", "user.email", "bot@example.com"], repoDir);

      // Create 3 commits, all returning exit 1
      for (let i = 1; i <= 3; i++) {
        writeFileSync(path.join(repoDir, "fail.mjs"), `process.exit(1); // step ${i}\n`, "utf-8");
        await runGit(["add", "fail.mjs"], repoDir);
        await runGit(["commit", "-m", `bad commit ${i}`], repoDir);
      }
      const headSha = await resolveRefToSha(repoDir, "HEAD");

      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: "auto",
        badRef: headSha,
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["fail.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const manifest = await engine.start(config);
      assert.equal(manifest.conclusion?.outcome, "inconclusive");
      assert.ok(
        manifest.conclusion?.explanation.includes("exhausted candidate history") ||
          manifest.conclusion?.explanation.includes("no ancestor candidate passed")
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("stops immediately when the bad endpoint passes the oracle (contradictory endpoint)", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-disco-badpasses-"));
    try {
      const { repoDir, shas } = await createDiscoveryTestRepo(tmpRoot);
      const engine = new LocalBisectEngine();
      // Point badRef to C2 (which returns 42 -> passes oracle)
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: "auto",
        badRef: shas[1]!, // C2 is good!
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["test.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const manifest = await engine.start(config);
      assert.equal(manifest.conclusion?.outcome, "inconclusive");
      assert.ok(manifest.conclusion?.explanation.includes("bad endpoint passed oracle"));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles a single-commit root repository (shallow/exhausted history with no ancestors)", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-disco-single-"));
    try {
      const repoDir = path.join(tmpRoot, "repo");
      mkdirSync(repoDir, { recursive: true });
      await runGit(["init", "-b", "main"], repoDir);
      await runGit(["config", "user.name", "Test Bot"], repoDir);
      await runGit(["config", "user.email", "bot@example.com"], repoDir);
      writeFileSync(path.join(repoDir, "file.txt"), "hello", "utf-8");
      await runGit(["add", "file.txt"], repoDir);
      await runGit(["commit", "-m", "initial commit"], repoDir);

      const headSha = await resolveRefToSha(repoDir, "HEAD");
      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: "auto",
        badRef: headSha,
        oracle: {
          mode: "in-tree",
          command: { command: "node", args: ["-e", "process.exit(1)"], timeoutMs: 5_000 },
        },
        execution: DEFAULT_EXECUTION_POLICY,
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const plan = await engine.plan(config);
      assert.equal(plan.ok, false);
      assert.ok(plan.warnings.some((w) => w.includes("no ancestors")));

      await assert.rejects(async () => {
        await engine.start(config);
      }, /Cannot start bisection plan/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("preserves explicit goodRef behavior unchanged", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-explicit-good-"));
    try {
      const { repoDir, shas } = await createDiscoveryTestRepo(tmpRoot);
      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "functional",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!, // Explicit C1
        badRef: shas[4]!,  // Explicit C5
        oracle: {
          mode: "in-tree",
          command: {
            command: "node",
            args: ["test.mjs"],
            timeoutMs: 10_000,
          },
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const plan = await engine.plan(config);
      assert.equal(plan.ok, true);
      assert.equal(plan.goodSha, shas[0]!);

      const manifest = await engine.start(config);
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.bounds.goodSha, shas[0]!);
      assert.equal(manifest.bounds.goodInputRef, shas[0]!);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
