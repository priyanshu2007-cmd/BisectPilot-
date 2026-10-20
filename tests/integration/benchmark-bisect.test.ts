import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  LocalBisectEngine,
  readLedgerEvents,
  resolveRefToSha,
  runGit,
  generateJsonReport,
  generateMarkdownReport,
  generateHtmlReport,
  generateGitHubStepSummary,
  type BisectConfigV1,
} from "../../src/index.js";

async function createBenchmarkRepoFixture(tmpRoot: string): Promise<{
  readonly repoDir: string;
  readonly shas: readonly string[];
  readonly plantedRegressionSha: string;
}> {
  const repoDir = path.join(tmpRoot, "bench-repo");
  mkdirSync(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Bench Bot"], repoDir);
  await runGit(["config", "user.email", "bench@example.com"], repoDir);

  const shas: string[] = [];

  // Commit 1: baseline fast performance (latency ~45ms)
  writeFileSync(
    path.join(repoDir, "bench.mjs"),
    `console.log(JSON.stringify({ latency_ms: 45 }));\n`,
    "utf-8"
  );
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "C1: baseline fast performance"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 2: unrelated docs update, fast performance continues
  writeFileSync(
    path.join(repoDir, "README.md"),
    `# Performance Benchmark Service\n`,
    "utf-8"
  );
  await runGit(["add", "README.md"], repoDir);
  await runGit(["commit", "-m", "C2: add documentation"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  // Commit 3: planted performance regression (latency jumps to 160ms)
  writeFileSync(
    path.join(repoDir, "bench.mjs"),
    `console.log(JSON.stringify({ latency_ms: 160 }));\n`,
    "utf-8"
  );
  await runGit(["add", "bench.mjs"], repoDir);
  await runGit(["commit", "-m", "C3: introduce quadratic algorithm regression"], repoDir);
  const plantedRegressionSha = await resolveRefToSha(repoDir, "HEAD");
  shas.push(plantedRegressionSha);

  // Commit 4: further work on top of regression
  writeFileSync(
    path.join(repoDir, "bench.mjs"),
    `console.log(JSON.stringify({ latency_ms: 165 }));\n`,
    "utf-8"
  );
  await runGit(["add", "bench.mjs"], repoDir);
  await runGit(["commit", "-m", "C4: additional changes with regression persisting"], repoDir);
  shas.push(await resolveRefToSha(repoDir, "HEAD"));

  return { repoDir, shas, plantedRegressionSha };
}

describe("Step 8 — Performance Regression & Benchmark Bisection Integration", () => {
  it("bisects git history and identifies planted performance regression using benchmark measurements", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "bp-bench-int-"));
    const { repoDir, shas, plantedRegressionSha } = await createBenchmarkRepoFixture(tmpRoot);

    try {
      const engine = new LocalBisectEngine();
      const config: BisectConfigV1 = {
        schemaVersion: 1,
        profile: "performance",
        repositoryRoot: repoDir,
        workingDirectory: ".",
        goodRef: shas[0]!,
        badRef: shas[3]!,
        oracle: {
          mode: "in-tree",
          command: {
            command: process.execPath,
            args: ["bench.mjs"],
            timeoutMs: 30000,
          },
        },
        benchmark: {
          metric: "latency_ms",
          threshold: 100,
          unit: "ms",
          warmup: 1,
          minSamples: 3,
          maxSamples: 5,
          alpha: 0.05,
          direction: "higher_is_worse",
        },
        execution: {
          ...DEFAULT_EXECUTION_POLICY,
          endpointFlakeRuns: 1,
          boundaryConfirmRuns: 1,
          confirmBeforeExecutingCode: false,
        },
        sessionRootDir: path.join(tmpRoot, "sessions"),
      };

      const manifest = await engine.start(config);

      assert.equal(manifest.state, "concluded");
      assert.equal(manifest.conclusion?.outcome, "candidate_confirmed");
      assert.equal(manifest.conclusion?.candidateSha, plantedRegressionSha);

      // Verify baseline was recorded in manifest
      assert.ok(manifest.benchmarkBaseline);
      assert.equal(manifest.benchmarkBaseline?.metric, "latency_ms");
      assert.equal(manifest.benchmarkBaseline?.mean, 45);

      // Verify ledger contains benchmark evidence
      const events = readLedgerEvents(manifest.ledgerPath);
      const classifiedEvents = events.filter((e) => e.type === "revision_classified");
      assert.ok(classifiedEvents.length >= 2);

      const regressionEvents = classifiedEvents.filter(
        (e) => e.type === "revision_classified" && e.benchmark?.decision === "regression"
      );
      assert.ok(regressionEvents.length > 0);

      const firstRegression = regressionEvents[0];
      if (firstRegression && firstRegression.type === "revision_classified") {
        assert.equal(firstRegression.benchmark?.metric, "latency_ms");
        assert.ok(firstRegression.benchmark?.absoluteDelta! > 50);
        assert.ok(firstRegression.benchmark?.tStatistic);
      }

      // Verify reporting generators support benchmark data
      const jsonReport = generateJsonReport(manifest, events);
      assert.ok(jsonReport.benchmark);
      assert.equal(jsonReport.benchmark?.metric, "latency_ms");
      assert.equal(jsonReport.benchmark?.baseline?.mean, 45);

      const markdownReport = generateMarkdownReport(manifest, events);
      assert.match(markdownReport, /Benchmark Performance Summary/);
      assert.match(markdownReport, /latency_ms/);

      const htmlReport = generateHtmlReport(manifest, events);
      assert.match(htmlReport, /Benchmark \(/);
      assert.match(htmlReport, /latency_ms/);

      const githubSummary = generateGitHubStepSummary(manifest, events);
      assert.match(githubSummary, /Benchmark Metric/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
