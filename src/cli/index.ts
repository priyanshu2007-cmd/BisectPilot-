import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalBisectEngine } from "../application/index.js";
import type { BisectEngine } from "../contracts/index.js";
import {
  DEFAULT_EXECUTION_POLICY,
  loadConfigFromFile,
  parseTermsOption,
  validateConfig,
  type BenchmarkDirection,
  type BenchmarkSpec,
  type BisectConfigV1,
  type ContainerSandboxPolicy,
  type RegressionProfile,
} from "../config/index.js";
import { readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import {
  appendGitHubStepSummary,
  generateGitHubIssueMarkdown,
  generateGitHubStepSummary,
  generateHtmlReport,
  generateJsonReport,
  generateMarkdownReport,
} from "../reports/index.js";
import {
  formatMinimizationReportJson,
  formatMinimizationReportMarkdown,
  type MinimizerGranularity,
} from "../domain/minimizer.js";
import { enqueueBisectJob, runDaemonCommand } from "../daemon/cli.js";
import { defaultDaemonStateDir } from "../daemon/index.js";
import { runWorkerCommand } from "../worker/cli.js";


const HELP_TEXT = `BisectPilot — Local-First Git Regression Bisection Engine

Usage:
  bisectpilot doctor [repoPath]
  bisectpilot init [--out <config.json>]
  bisectpilot plan --config <config.json> [--cwd <path>] [--scope <paths>] [--good <ref>] [--bad <ref>] [--terms <old,new>] [--sandbox <docker|podman>] [--sandbox-image <repo@sha256:...>] [--metric <name>] [--threshold <num>] [--relative-regression <val>]
  bisectpilot start --config <config.json> [--cwd <path>] [--scope <paths>] [--yes] [--background] [--good <ref>] [--bad <ref>] [--terms <old,new>] [--sandbox <docker|podman>] [--sandbox-image <repo@sha256:...>] [--noisy] [--prompt] [--metric <name>] [--threshold <num>] [--relative-regression <val>] [--direction <dir>] [--warmup <n>] [--samples <n>] [--max-samples <n>] [--alpha <n>] [--unit <str>]   (alias: run)
  bisectpilot status <sessionId> [--session-root <dir>]
  bisectpilot resume <sessionId> [--session-root <dir>]
  bisectpilot report <sessionId> [--json] [--html] [--github-summary [file]] [--github-issue] [--out <file>] [--verify] [--session-root <dir>]
  bisectpilot cleanup <sessionId> [--dry-run] [--session-root <dir>]
  bisectpilot list [--session-root <dir>]
  bisectpilot daemon start|status|stop|enqueue|cancel|recover [options]
  bisectpilot worker start|status|stop [options]
  bisectpilot minimize <inputPath> --test <cmd> [--args <args>] [--out <path>] [--budget <n>] [--timeout <ms>] [--granularity <line|char|both>] [--noisy] [--json]
`;

export function parseBenchmarkCliOptions(
  args: readonly string[],
  existingBenchmark?: BenchmarkSpec
): { ok: true; benchmark?: BenchmarkSpec; profile?: RegressionProfile } | { ok: false; error: string } {
  const metricIdx = args.indexOf("--metric");
  const rawMetric = metricIdx >= 0 ? args[metricIdx + 1] : undefined;

  if (metricIdx >= 0 && (!rawMetric || rawMetric.startsWith("--"))) {
    return { ok: false, error: "Missing argument for --metric <name>" };
  }

  const thresholdIdx = args.indexOf("--threshold");
  const rawThreshold = thresholdIdx >= 0 ? args[thresholdIdx + 1] : undefined;
  let threshold: number | undefined = existingBenchmark?.threshold;
  if (thresholdIdx >= 0) {
    if (!rawThreshold || rawThreshold.startsWith("--")) {
      return { ok: false, error: "Missing argument for --threshold <number>" };
    }
    const val = Number(rawThreshold);
    if (!Number.isFinite(val)) {
      return { ok: false, error: `Invalid --threshold "${rawThreshold}": must be a finite number` };
    }
    threshold = val;
  }

  const relIdx = args.indexOf("--relative-regression");
  const rawRel = relIdx >= 0 ? args[relIdx + 1] : undefined;
  let relativeRegression: number | undefined = existingBenchmark?.relativeRegression;
  if (relIdx >= 0) {
    if (!rawRel || rawRel.startsWith("--")) {
      return { ok: false, error: "Missing argument for --relative-regression <val>" };
    }
    const cleanRel = rawRel.replace(/%$/, "").trim();
    const val = Number(cleanRel);
    if (!Number.isFinite(val) || val < 0) {
      return { ok: false, error: `Invalid --relative-regression "${rawRel}": must be a non-negative number` };
    }
    relativeRegression = val > 1.0 ? val / 100 : val;
  }

  const dirIdx = args.indexOf("--direction");
  const rawDir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
  let direction: BenchmarkDirection = existingBenchmark?.direction ?? "higher_is_worse";
  if (dirIdx >= 0) {
    if (!rawDir || rawDir.startsWith("--")) {
      return { ok: false, error: "Missing argument for --direction <higher_is_worse|lower_is_worse>" };
    }
    const normalized = rawDir.toLowerCase().trim();
    if (normalized === "higher_is_worse" || normalized === "higher" || normalized === "asc") {
      direction = "higher_is_worse";
    } else if (normalized === "lower_is_worse" || normalized === "lower" || normalized === "desc") {
      direction = "lower_is_worse";
    } else {
      return { ok: false, error: `Invalid --direction "${rawDir}": must be "higher_is_worse" or "lower_is_worse"` };
    }
  }

  const warmupIdx = args.indexOf("--warmup");
  const rawWarmup = warmupIdx >= 0 ? args[warmupIdx + 1] : undefined;
  let warmup = existingBenchmark?.warmup ?? 1;
  if (warmupIdx >= 0) {
    if (!rawWarmup || rawWarmup.startsWith("--")) {
      return { ok: false, error: "Missing argument for --warmup <integer>" };
    }
    const val = parseInt(rawWarmup, 10);
    if (isNaN(val) || val < 0) {
      return { ok: false, error: `Invalid --warmup "${rawWarmup}": must be an integer >= 0` };
    }
    warmup = val;
  }

  const samplesIdx = args.indexOf("--samples") >= 0 ? args.indexOf("--samples") : args.indexOf("--min-samples");
  const rawSamples = samplesIdx >= 0 ? args[samplesIdx + 1] : undefined;
  let minSamples = existingBenchmark?.minSamples ?? 3;
  if (samplesIdx >= 0) {
    if (!rawSamples || rawSamples.startsWith("--")) {
      return { ok: false, error: "Missing argument for --samples / --min-samples <integer>" };
    }
    const val = parseInt(rawSamples, 10);
    if (isNaN(val) || val < 1) {
      return { ok: false, error: `Invalid --samples "${rawSamples}": must be an integer >= 1` };
    }
    minSamples = val;
  }

  const maxSamplesIdx = args.indexOf("--max-samples");
  const rawMaxSamples = maxSamplesIdx >= 0 ? args[maxSamplesIdx + 1] : undefined;
  let maxSamples = existingBenchmark?.maxSamples ?? Math.max(10, minSamples);
  if (maxSamplesIdx >= 0) {
    if (!rawMaxSamples || rawMaxSamples.startsWith("--")) {
      return { ok: false, error: "Missing argument for --max-samples <integer>" };
    }
    const val = parseInt(rawMaxSamples, 10);
    if (isNaN(val) || val < minSamples) {
      return { ok: false, error: `Invalid --max-samples "${rawMaxSamples}": must be an integer >= minSamples (${minSamples})` };
    }
    maxSamples = val;
  }

  const alphaIdx = args.indexOf("--alpha");
  const rawAlpha = alphaIdx >= 0 ? args[alphaIdx + 1] : undefined;
  let alpha = existingBenchmark?.alpha ?? 0.05;
  if (alphaIdx >= 0) {
    if (!rawAlpha || rawAlpha.startsWith("--")) {
      return { ok: false, error: "Missing argument for --alpha <number>" };
    }
    const val = Number(rawAlpha);
    if (!Number.isFinite(val) || val <= 0 || val > 0.5) {
      return { ok: false, error: `Invalid --alpha "${rawAlpha}": must be a number between 0 and 0.5` };
    }
    alpha = val;
  }

  const unitIdx = args.indexOf("--unit");
  const rawUnit = unitIdx >= 0 ? args[unitIdx + 1] : undefined;
  let unit = existingBenchmark?.unit;
  if (unitIdx >= 0) {
    if (!rawUnit || rawUnit.startsWith("--")) {
      return { ok: false, error: "Missing argument for --unit <string>" };
    }
    unit = rawUnit.trim();
  }

  const metric = rawMetric?.trim() ?? existingBenchmark?.metric;
  if (metric) {
    return {
      ok: true,
      profile: "performance",
      benchmark: {
        metric,
        ...(unit ? { unit } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(relativeRegression !== undefined ? { relativeRegression } : {}),
        direction,
        warmup,
        minSamples,
        maxSamples,
        alpha,
      },
    };
  }

  return { ok: true };
}

function parseSandboxCliOptions(
  args: readonly string[],
  existing?: ContainerSandboxPolicy
): { ok: true; sandbox?: ContainerSandboxPolicy } | { ok: false; error: string } {
  const runtimeIdx = args.indexOf("--sandbox");
  const imageIdx = args.indexOf("--sandbox-image");
  if (runtimeIdx < 0 && imageIdx < 0) return { ok: true, ...(existing ? { sandbox: existing } : {}) };
  const rawRuntime = runtimeIdx >= 0 ? args[runtimeIdx + 1] : existing?.runtime;
  const rawImage = imageIdx >= 0 ? args[imageIdx + 1] : existing?.image;
  if (!rawRuntime || rawRuntime.startsWith("--")) return { ok: false, error: "Missing argument for --sandbox <docker|podman>" };
  if (rawRuntime !== "docker" && rawRuntime !== "podman") return { ok: false, error: `Invalid --sandbox "${rawRuntime}": use docker or podman` };
  if (!rawImage || rawImage.startsWith("--")) return { ok: false, error: "Sandbox mode requires --sandbox-image <repo@sha256:...> or execution.sandbox.image" };
  return {
    ok: true,
    sandbox: {
      runtime: rawRuntime,
      image: rawImage,
      network: "none",
      resources: existing?.resources ?? { cpus: 1, memoryMb: 512, pidsLimit: 256, tmpfsMb: 128 },
    },
  };
}


export function createStarterConfig(repoRoot = "."): BisectConfigV1 {
  return {
    schemaVersion: 1,
    profile: "functional",
    repositoryRoot: repoRoot,
    workingDirectory: ".",
    goodRef: "HEAD~5",
    badRef: "HEAD",
    oracle: {
      mode: "in-tree",
      command: {
        command: "npm",
        args: ["test"],
        timeoutMs: 180_000,
      },
    },
    execution: DEFAULT_EXECUTION_POLICY,
  };
}

export async function runCli(
  argv: readonly string[],
  engineOverride?: BisectEngine
): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const engine = engineOverride ?? new LocalBisectEngine();
  const cmd = args[0];

  if (cmd === "daemon") return runDaemonCommand(args.slice(1), engine);
  if (cmd === "worker") return runWorkerCommand(args.slice(1), engine);

  if (cmd === "doctor") {
    const report = await engine.doctor(args[1] ?? ".");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }

  if (cmd === "init") {
    const outIdx = args.indexOf("--out");
    const outPath = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : "bisectpilot.config.json");
    if (existsSync(outPath) && !args.includes("--force")) {
      process.stderr.write(`Config file already exists at ${outPath} (use --force to overwrite)\n`);
      return 2;
    }
    const starter = createStarterConfig(".");
    writeFileSync(outPath, JSON.stringify(starter, null, 2) + "\n", "utf-8");
    process.stdout.write(`Wrote starter config to ${outPath}\n`);
    return 0;
  }

  if (cmd === "plan") {
    const cfgIdx = args.indexOf("--config");
    const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : undefined;
    if (!cfgPath) {
      process.stderr.write("Missing --config <path>\n");
      return 2;
    }
    const validated = loadConfigFromFile(cfgPath);
    if (!validated.ok) {
      process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
      return 2;
    }
    const goodIdx = args.indexOf("--good");
    const badIdx = args.indexOf("--bad");
    const termsIdx = args.indexOf("--terms");
    let activeConfig = validated.value;
    if (goodIdx >= 0 && args[goodIdx + 1]) {
      activeConfig = { ...activeConfig, goodRef: args[goodIdx + 1]! };
    }
    if (badIdx >= 0 && args[badIdx + 1]) {
      activeConfig = { ...activeConfig, badRef: args[badIdx + 1]! };
    }
    if (termsIdx >= 0) {
      const rawTerms = args[termsIdx + 1];
      if (!rawTerms) {
        process.stderr.write("Missing argument for --terms <old,new>\n");
        return 2;
      }
      const parsedTerms = parseTermsOption(rawTerms);
      if (!parsedTerms.ok) {
        process.stderr.write(`Invalid --terms: ${parsedTerms.error}\n`);
        return 2;
      }
      activeConfig = { ...activeConfig, terms: parsedTerms.value };
    }
    const cwdIdx = args.indexOf("--cwd");
    if (cwdIdx >= 0) {
      const rawCwd = args[cwdIdx + 1];
      if (!rawCwd || rawCwd.startsWith("--")) {
        process.stderr.write("Missing argument for --cwd <path>\n");
        return 2;
      }
      activeConfig = { ...activeConfig, workingDirectory: rawCwd.trim() };
    }
    const scopeIdx = args.indexOf("--scope");
    if (scopeIdx >= 0) {
      const rawScope = args[scopeIdx + 1];
      if (!rawScope || rawScope.startsWith("--")) {
        process.stderr.write("Missing argument for --scope <path,path,...>\n");
        return 2;
      }
      const scopes = rawScope.split(",").map((s) => s.trim()).filter(Boolean);
      activeConfig = { ...activeConfig, pathScope: scopes };
    }
    const benchOpt = parseBenchmarkCliOptions(args, activeConfig.benchmark);
    if (!benchOpt.ok) {
      process.stderr.write(`${benchOpt.error}\n`);
      return 2;
    }
    if (benchOpt.benchmark) {
      activeConfig = {
        ...activeConfig,
        profile: benchOpt.profile ?? activeConfig.profile,
        benchmark: benchOpt.benchmark,
      };
    }
    const sandboxPlan = parseSandboxCliOptions(args, activeConfig.execution.sandbox);
    if (!sandboxPlan.ok) {
      process.stderr.write(`${sandboxPlan.error}\n`);
      return 2;
    }
    if (sandboxPlan.sandbox) activeConfig = { ...activeConfig, execution: { ...activeConfig.execution, sandbox: sandboxPlan.sandbox } };
    const valPlan = validateConfig(activeConfig);
    if (!valPlan.ok) {
      process.stderr.write(JSON.stringify(valPlan.issues, null, 2) + "\n");
      return 2;
    }
    activeConfig = valPlan.value;
    const plan = await engine.plan(activeConfig);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return plan.ok ? 0 : 1;
  }

  if (cmd === "start" || cmd === "run") {
    const cfgIdx = args.indexOf("--config");
    const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : undefined;
    const autoYes = args.includes("--yes");
    if (!cfgPath) {
      process.stderr.write("Missing --config <path>\n");
      return 2;
    }
    const validated = loadConfigFromFile(cfgPath);
    if (!validated.ok) {
      process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
      return 2;
    }
    const goodIdx = args.indexOf("--good");
    const badIdx = args.indexOf("--bad");
    const termsIdx = args.indexOf("--terms");
    let activeConfig = validated.value;
    if (goodIdx >= 0 && args[goodIdx + 1]) {
      activeConfig = { ...activeConfig, goodRef: args[goodIdx + 1]! };
    }
    if (badIdx >= 0 && args[badIdx + 1]) {
      activeConfig = { ...activeConfig, badRef: args[badIdx + 1]! };
    }
    if (termsIdx >= 0) {
      const rawTerms = args[termsIdx + 1];
      if (!rawTerms) {
        process.stderr.write("Missing argument for --terms <old,new>\n");
        return 2;
      }
      const parsedTerms = parseTermsOption(rawTerms);
      if (!parsedTerms.ok) {
        process.stderr.write(`Invalid --terms: ${parsedTerms.error}\n`);
        return 2;
      }
      activeConfig = { ...activeConfig, terms: parsedTerms.value };
    }
    const cwdIdx = args.indexOf("--cwd");
    if (cwdIdx >= 0) {
      const rawCwd = args[cwdIdx + 1];
      if (!rawCwd || rawCwd.startsWith("--")) {
        process.stderr.write("Missing argument for --cwd <path>\n");
        return 2;
      }
      activeConfig = { ...activeConfig, workingDirectory: rawCwd.trim() };
    }
    const scopeIdx = args.indexOf("--scope");
    if (scopeIdx >= 0) {
      const rawScope = args[scopeIdx + 1];
      if (!rawScope || rawScope.startsWith("--")) {
        process.stderr.write("Missing argument for --scope <path,path,...>\n");
        return 2;
      }
      const scopes = rawScope.split(",").map((s) => s.trim()).filter(Boolean);
      activeConfig = { ...activeConfig, pathScope: scopes };
    }
    if (args.includes("--prompt")) {
      activeConfig = {
        ...activeConfig,
        execution: {
          ...activeConfig.execution,
          interactivePrompt: true,
        },
      };
    }
    if (args.includes("--noisy")) {
      activeConfig = {
        ...activeConfig,
        execution: {
          ...activeConfig.execution,
          noisyOracle: {
            ...activeConfig.execution.noisyOracle,
            enabled: true,
            maxSamplesPerRevision: activeConfig.execution.noisyOracle?.maxSamplesPerRevision ?? 5,
            confidenceThreshold: activeConfig.execution.noisyOracle?.confidenceThreshold ?? 0.90,
            flakeRate: activeConfig.execution.noisyOracle?.flakeRate ?? 0.10,
          },
        },
      };
    }
    const startBenchOpt = parseBenchmarkCliOptions(args, activeConfig.benchmark);
    if (!startBenchOpt.ok) {
      process.stderr.write(`${startBenchOpt.error}\n`);
      return 2;
    }
    if (startBenchOpt.benchmark) {
      activeConfig = {
        ...activeConfig,
        profile: startBenchOpt.profile ?? activeConfig.profile,
        benchmark: startBenchOpt.benchmark,
      };
    }
    const sandboxStart = parseSandboxCliOptions(args, activeConfig.execution.sandbox);
    if (!sandboxStart.ok) {
      process.stderr.write(`${sandboxStart.error}\n`);
      return 2;
    }
    if (sandboxStart.sandbox) activeConfig = { ...activeConfig, execution: { ...activeConfig.execution, sandbox: sandboxStart.sandbox } };
    const ghSummaryIdx = args.indexOf("--github-summary");
    if (ghSummaryIdx >= 0) {
      const nextArg = args[ghSummaryIdx + 1];
      const customPath = nextArg && !nextArg.startsWith("--") ? nextArg : undefined;
      if (customPath) {
        process.env.GITHUB_STEP_SUMMARY = path.resolve(customPath);
      }
    }
    const valStart = validateConfig(activeConfig);
    if (!valStart.ok) {
      process.stderr.write(JSON.stringify(valStart.issues, null, 2) + "\n");
      return 2;
    }
    activeConfig = valStart.value;
    if (activeConfig.execution.confirmBeforeExecutingCode && !autoYes) {
      process.stderr.write("Refusing to execute historical repository code without --yes consent flag.\n");
      return 3;
    }
    if (args.includes("--background")) {
      const stateDirIdx = args.indexOf("--daemon-state-dir");
      const stateDir = path.resolve(stateDirIdx >= 0 && args[stateDirIdx + 1] ? args[stateDirIdx + 1]! : defaultDaemonStateDir());
      const repoKeyIdx = args.indexOf("--repository-key");
      const repositoryKey = repoKeyIdx >= 0 && args[repoKeyIdx + 1] ? args[repoKeyIdx + 1]! : "default";
      try {
        const job = await enqueueBisectJob(activeConfig, stateDir, repositoryKey, engine);
        process.stdout.write(JSON.stringify(job, null, 2) + "\n");
        return 0;
      } catch (error: unknown) {
        process.stderr.write(`Background enqueue failed: ${(error as Error).message}\n`);
        return 1;
      }
    }
    const abortController = new AbortController();
    const onSig = () => abortController.abort();
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    try {
      const manifest = await engine.start(activeConfig, {
        confirm: () => autoYes,
        abortSignal: abortController.signal,
      });
      process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
      return manifest.conclusion?.outcome === "candidate_confirmed" ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }
  }

  if (cmd === "status") {
    const sessionId = args[1];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const rootIdx = args.indexOf("--session-root");
    const sessionRoot = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
    const status = await engine.status(sessionId, sessionRoot);
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }

  if (cmd === "resume") {
    const sessionId = args[1];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const rootIdx = args.indexOf("--session-root");
    const sessionRoot = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
    const abortController = new AbortController();
    const onSig = () => abortController.abort();
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    try {
      const manifest = await engine.resume(
        sessionId,
        { abortSignal: abortController.signal },
        sessionRoot
      );
      process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
      return manifest.conclusion?.outcome === "candidate_confirmed" ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }
  }

  if (cmd === "report") {
    const sessionId = args[1];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const rootIdx = args.indexOf("--session-root");
    const sessionRoot = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
    const outIdx = args.indexOf("--out");
    const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

    const status = await engine.status(sessionId, sessionRoot);
    const events = readLedgerEvents(status.manifest.ledgerPath);
    if (args.includes("--verify")) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        process.stderr.write(`Ledger verification failed: ${check.reason}\n`);
        return 1;
      }
    }

    const ghSummaryIdx = args.indexOf("--github-summary");
    if (ghSummaryIdx >= 0) {
      const nextArg = args[ghSummaryIdx + 1];
      const customPath = nextArg && !nextArg.startsWith("--") ? nextArg : undefined;
      const targetPath = customPath ?? process.env.GITHUB_STEP_SUMMARY;
      if (!targetPath) {
        process.stderr.write(
          "Error: GITHUB_STEP_SUMMARY environment variable is not set; specify a file path with --github-summary <path>\n"
        );
        return 1;
      }
      const summaryMd = generateGitHubStepSummary(status.manifest, events);
      const res = appendGitHubStepSummary(summaryMd, targetPath);
      if (!res.written) {
        process.stderr.write(`Failed to append GitHub step summary to ${res.targetPath}: ${res.error}\n`);
        return 1;
      }
      process.stdout.write(`Appended GitHub step summary to ${res.targetPath}\n`);
      return 0;
    }

    if (args.includes("--github-issue")) {
      const issueMd = generateGitHubIssueMarkdown(status.manifest, events);
      if (outPath) {
        const resolved = path.resolve(outPath);
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, issueMd, "utf-8");
        process.stdout.write(`Wrote GitHub issue report to ${outPath}\n`);
      } else {
        process.stdout.write(issueMd);
      }
      return 0;
    }

    if (args.includes("--html")) {
      const htmlText = generateHtmlReport(status.manifest, events);
      if (outPath) {
        const resolved = path.resolve(outPath);
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, htmlText, "utf-8");
        process.stdout.write(`Wrote HTML report to ${outPath}\n`);
      } else {
        process.stdout.write(htmlText);
      }
      return 0;
    }

    if (args.includes("--json")) {
      const jsonText = JSON.stringify(generateJsonReport(status.manifest, events), null, 2) + "\n";
      if (outPath) {
        const resolved = path.resolve(outPath);
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, jsonText, "utf-8");
        process.stdout.write(`Wrote JSON report to ${outPath}\n`);
      } else {
        process.stdout.write(jsonText);
      }
      return 0;
    }

    const mdText = generateMarkdownReport(status.manifest, events);
    if (outPath) {
      const resolved = path.resolve(outPath);
      mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, mdText, "utf-8");
      process.stdout.write(`Wrote Markdown report to ${outPath}\n`);
    } else {
      process.stdout.write(mdText);
    }
    return 0;
  }

  if (cmd === "cleanup") {
    const sessionId = args[1];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const dryRun = args.includes("--dry-run");
    const rootIdx = args.indexOf("--session-root");
    const sessionRoot = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
    const res = await engine.cleanup(sessionId, { dryRun }, sessionRoot);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }

  if (cmd === "list") {
    const rootIdx = args.indexOf("--session-root");
    const sessionRoot = rootIdx >= 0 ? args[rootIdx + 1] : undefined;
    const items = await engine.list(sessionRoot);
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
  }

  if (cmd === "minimize") {

    let inputPath = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    const inputIdx = args.indexOf("--input");
    if (inputIdx >= 0 && args[inputIdx + 1]) {
      inputPath = args[inputIdx + 1];
    }

    if (!inputPath) {
      process.stderr.write("Missing <inputPath> to minimize\n");
      return 2;
    }

    const testIdx = args.indexOf("--test");
    const testCmd = testIdx >= 0 ? args[testIdx + 1] : undefined;
    if (!testCmd) {
      process.stderr.write("Missing --test <command>\n");
      return 2;
    }

    const outIdx = args.indexOf("--out");
    const outputPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

    const budgetIdx = args.indexOf("--budget");
    const budget = budgetIdx >= 0 && args[budgetIdx + 1] ? parseInt(args[budgetIdx + 1]!, 10) : undefined;

    const timeoutIdx = args.indexOf("--timeout");
    const timeoutMs = timeoutIdx >= 0 && args[timeoutIdx + 1] ? parseInt(args[timeoutIdx + 1]!, 10) : undefined;

    const granIdx = args.indexOf("--granularity");
    const rawGran = granIdx >= 0 ? args[granIdx + 1] : undefined;
    const granularity: MinimizerGranularity | undefined =
      rawGran === "char" || rawGran === "both" || rawGran === "line" ? rawGran : undefined;

    let testArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--arg" && args[i + 1]) {
        testArgs.push(args[i + 1]!);
        i++;
      }
    }
    const argsIdx = args.indexOf("--args");
    if (argsIdx >= 0 && args[argsIdx + 1] && testArgs.length === 0) {
      testArgs = args[argsIdx + 1]!.split(",").map((s) => s.trim());
    }
    const finalArgs = testArgs.length > 0 ? testArgs : undefined;


    const noisy = args.includes("--noisy");
    const overwrite = args.includes("--force");

    try {
      const localEngine = engine instanceof LocalBisectEngine ? engine : new LocalBisectEngine();
      const result = await localEngine.minimize({
        inputPath,
        outputPath,
        testCommand: testCmd,
        testArgs: finalArgs,
        timeoutMs,
        maxEvaluations: budget,
        granularity,
        noisy,
        overwriteOutput: overwrite,
      });


      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify(formatMinimizationReportJson(result), null, 2) + "\n");
      } else {
        process.stdout.write(formatMinimizationReportMarkdown(result) + "\n");
      }

      return result.success ? 0 : 1;
    } catch (err: unknown) {
      process.stderr.write(`Minimization error: ${(err as Error).message}\n`);
      return 1;
    }
  }

  process.stderr.write(`Unknown command: ${cmd}\n${HELP_TEXT}`);
  return 2;
}
