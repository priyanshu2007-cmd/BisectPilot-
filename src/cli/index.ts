import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalBisectEngine } from "../application/index.js";
import {
  DEFAULT_EXECUTION_POLICY,
  loadConfigFromFile,
  parseTermsOption,
  validateConfig,
  type BisectConfigV1,
} from "../config/index.js";
import { readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import { generateJsonReport, generateMarkdownReport } from "../reports/index.js";

const HELP_TEXT = `BisectPilot — Local-First Git Regression Bisection Engine

Usage:
  bisectpilot doctor [repoPath]
  bisectpilot init [--out <config.json>]
  bisectpilot plan --config <config.json> [--good <ref>] [--bad <ref>] [--terms <old,new>]
  bisectpilot start --config <config.json> [--yes] [--good <ref>] [--bad <ref>] [--terms <old,new>] [--noisy] [--prompt]   (alias: run)
  bisectpilot status <sessionId> [--session-root <dir>]
  bisectpilot resume <sessionId> [--session-root <dir>]
  bisectpilot report <sessionId> [--json] [--verify] [--session-root <dir>]
  bisectpilot cleanup <sessionId> [--dry-run] [--session-root <dir>]
  bisectpilot list [--session-root <dir>]
`;

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

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const engine = new LocalBisectEngine();
  const cmd = args[0];

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
    const status = await engine.status(sessionId, sessionRoot);
    const events = readLedgerEvents(status.manifest.ledgerPath);
    if (args.includes("--verify")) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        process.stderr.write(`Ledger verification failed: ${check.reason}\n`);
        return 1;
      }
    }
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(generateJsonReport(status.manifest, events), null, 2) + "\n");
    } else {
      process.stdout.write(generateMarkdownReport(status.manifest, events));
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

  process.stderr.write(`Unknown command: ${cmd}\n${HELP_TEXT}`);
  return 2;
}
