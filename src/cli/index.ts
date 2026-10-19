import { LocalBisectEngine } from "../application/index.js";
import { loadConfigFromFile } from "../config/index.js";
import { readLedgerEvents, verifyLedgerChain } from "../ledger/index.js";
import { generateMarkdownReport } from "../reports/index.js";

const HELP_TEXT = `BisectPilot — Local-First Git Regression Bisection Engine

Usage:
  bisectpilot doctor [repoPath]
  bisectpilot plan --config <config.json>
  bisectpilot start --config <config.json> [--yes]
  bisectpilot status <sessionId> [--session-root <dir>]
  bisectpilot report <sessionId> [--verify] [--session-root <dir>]
  bisectpilot cleanup <sessionId> [--dry-run] [--session-root <dir>]
  bisectpilot list [--session-root <dir>]
`;

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
    const plan = await engine.plan(validated.value);
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return plan.ok ? 0 : 1;
  }

  if (cmd === "start") {
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
    if (validated.value.execution.confirmBeforeExecutingCode && !autoYes) {
      process.stderr.write("Refusing to execute historical repository code without --yes consent flag.\n");
      return 3;
    }
    const manifest = await engine.start(validated.value, {
      confirm: () => autoYes,
    });
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
    return manifest.conclusion?.outcome === "candidate_confirmed" ? 0 : 1;
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
    process.stdout.write(generateMarkdownReport(status.manifest, events));
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
