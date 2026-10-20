import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { LocalBisectEngine } from "../application/index.js";
import type { BisectEngine, LedgerEvent, SessionManifestV1 } from "../contracts/index.js";
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
  redactSensitiveText,
} from "../reports/index.js";
import {
  formatMinimizationReportJson,
  formatMinimizationReportMarkdown,
  type MinimizerGranularity,
} from "../domain/minimizer.js";
import { enqueueBisectJob, runDaemonCommand } from "../daemon/cli.js";
import { defaultDaemonStateDir } from "../daemon/index.js";
import { runWorkerCommand } from "../worker/cli.js";
import { runGit } from "../git/index.js";


const HELP_TEXT = `BisectPilot — Local-First Git Regression Bisection Engine

Commands:
  doctor     Check Git and repository prerequisites.
  init       Write a starter JSON configuration.
  plan       Validate bounds and estimate a run; use -- <command> for zero-config mode.
  start/run  Execute a bisection; use --yes -- <command> [args...] and optional --prompt/--json.
  status     Inspect a session and recovery metadata.
  resume     Resume an interrupted session.
  report     Export Markdown, JSON, HTML, or GitHub reports.
  cleanup    Remove a tool-owned session worktree.
  list       List recorded sessions.
  bisectpilot minimize  Reduce a failure-inducing input.
  daemon     Manage the optional daemon queue.
  worker     Manage the optional pull worker.

Run \`bisectpilot <command> --help\` for details.
`;

const RECOVERY_HELP = `Session Recovery & Invariants:
  If state is 'needs_recovery', the process terminated abruptly. Inspect checkpointSeq,
  lastWalSeq, classifiedCount, and resumable before resuming.
  Recovery is blocked when a live lock, repository mismatch, missing ownership marker,
  broken ledger hash chain, or unsupported checkpoint schema is detected.
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  doctor: `Usage: bisectpilot doctor [repoPath]\n\nCheck Git and repository prerequisites.\n\nFlags: -h, --help  Show this help.\nExamples:\n  bisectpilot doctor .\n`,
  init: `Usage: bisectpilot init [--out <file>] [--force]\n\nWrite a starter configuration using safe defaults.\n\nFlags: --out <file>  Output path (default: bisectpilot.config.json).\n       --force       Overwrite an existing file.\nExamples:\n  bisectpilot init\n  bisectpilot init --out bisectpilot.config.json --force\n`,
  plan: `Usage: bisectpilot plan [--config <file>] --good <ref> --bad <ref> -- <command> [args...]\n\nValidate bounds and estimate a bisection without executing repository code.\n\nFlags: --config <file>  Load a config; inline command overrides oracle.command.\n       --good <ref>     Known-good ref (auto is supported).\n       --bad <ref>      Known-bad ref.\n       --timeout <ms>   Inline oracle timeout (default: 180000).\nExamples:\n  bisectpilot plan --good v1.0 --bad HEAD -- npm test\n  bisectpilot plan --config bisectpilot.config.json -- node check.js\n`,
  start: `Usage: bisectpilot start [options] -- <command> [args...]\n       bisectpilot run [options] -- <command> [args...]\n\nRun endpoint checks, native Git Bisect, and boundary confirmation.\n\nFlags: --config <file>  Load a config; inline command overrides oracle.command.\n       --good <ref>     Known-good ref (required without --config).\n       --bad <ref>      Known-bad ref (required without --config).\n       --yes             Consent to execute historical repository code.\n       --timeout <ms>   Inline oracle timeout (default: 180000).\n       --prompt          Ask for interactive classification.\n       --noisy           Enable noisy-oracle sampling.\n       --background      Enqueue through the optional daemon.\n       --json            Print the final session manifest as JSON.\nExamples:\n  bisectpilot start --good v1.0 --bad HEAD --yes -- npm test\n  bisectpilot start --good auto --bad HEAD --yes -- ./scripts/check.sh --fast\n`,
  status: `Usage: bisectpilot status <sessionId> [--session-root <dir>]\n\nInspect session state, lock status, and checkpoint metadata.\n\nFlags: --session-root <dir>  Override the session root.\n\n${RECOVERY_HELP}`,
  resume: `Usage: bisectpilot resume <sessionId> [--session-root <dir>]\n\nResume an interrupted or recoverable session.\n\nFlags: --session-root <dir>  Override the session root.\n       --json                 Print the final session manifest as JSON.\n\n${RECOVERY_HELP}`,
  report: `Usage: bisectpilot report <sessionId> [format flags]\n\nExport session evidence. Markdown is the default format.\n\nFlags: --json, --html, --github-issue, --github-summary [file], --out <file>, --verify.\nExamples:\n  bisectpilot report bp-123 --json --verify\n  bisectpilot report bp-123 --html --out report.html\n`,
  cleanup: `Usage: bisectpilot cleanup <sessionId> [--dry-run]\n\nRemove the tool-owned session worktree.\n\nFlags: --dry-run  Preview cleanup without removing files.\nExample:\n  bisectpilot cleanup bp-123 --dry-run\n`,
  list: `Usage: bisectpilot list [--session-root <dir>]\n\nList recorded sessions.\n\nFlags: --session-root <dir>  Override the session root.\nExample:\n  bisectpilot list\n`,
  minimize: `Usage: bisectpilot minimize <inputPath> --test <command> [options]\n\nReduce a failure-inducing input with Delta Debugging.\n\nFlags: --test <command>, --arg <value>, --args <csv>, --budget <n>, --timeout <ms>, --granularity <line|char|both>, --noisy, --force, --json.\nExamples:\n  bisectpilot minimize input.txt --test node --arg check.js\n  bisectpilot minimize input.txt --test ./check.sh --json\n`,
  daemon: `Usage: bisectpilot daemon <start|status|stop|enqueue|cancel|recover|revoke> [options]\n\nManage the optional local daemon queue.\n\nRun \`bisectpilot daemon <command> --help\` for service-specific options.\n`,
  worker: `Usage: bisectpilot worker <start|status|stop> [options]\n\nManage the optional pull worker.\n\nRun \`bisectpilot worker <command> --help\` for service-specific options.\n`,
};

function commandHelp(command: string | undefined): string {
  return COMMAND_HELP[command === "run" ? "start" : command ?? ""] ?? HELP_TEXT;
}

type CliOption = {
  readonly type: "boolean" | "string";
  readonly short?: string;
  readonly multiple?: boolean;
};
type CliOptionTable = Readonly<Record<string, CliOption>>;

const GLOBAL_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;
const COMMON_OPTIONS = {
  config: { type: "string" },
  good: { type: "string" },
  bad: { type: "string" },
  terms: { type: "string" },
  cwd: { type: "string" },
  scope: { type: "string" },
  sandbox: { type: "string" },
  "sandbox-image": { type: "string" },
  metric: { type: "string" },
  threshold: { type: "string" },
  "relative-regression": { type: "string" },
  direction: { type: "string" },
  warmup: { type: "string" },
  samples: { type: "string" },
  "min-samples": { type: "string" },
  "max-samples": { type: "string" },
  alpha: { type: "string" },
  unit: { type: "string" },
  timeout: { type: "string" },
} as const;

export const CLI_OPTION_TABLES: Readonly<Record<string, CliOptionTable>> = {
  doctor: GLOBAL_OPTIONS,
  init: { ...GLOBAL_OPTIONS, out: { type: "string" }, force: { type: "boolean" } },
  plan: { ...GLOBAL_OPTIONS, ...COMMON_OPTIONS },
  start: {
    ...GLOBAL_OPTIONS,
    ...COMMON_OPTIONS,
    yes: { type: "boolean" },
    background: { type: "boolean" },
    prompt: { type: "boolean" },
    noisy: { type: "boolean" },
    "github-summary": { type: "boolean" },
    "daemon-state-dir": { type: "string" },
    "repository-key": { type: "string" },
    json: { type: "boolean" },
  },
  status: { ...GLOBAL_OPTIONS, "session-root": { type: "string" } },
  resume: { ...GLOBAL_OPTIONS, "session-root": { type: "string" }, json: { type: "boolean" } },
  report: {
    ...GLOBAL_OPTIONS,
    "session-root": { type: "string" },
    out: { type: "string" },
    verify: { type: "boolean" },
    "github-summary": { type: "boolean" },
    "github-issue": { type: "boolean" },
    html: { type: "boolean" },
    json: { type: "boolean" },
  },
  cleanup: { ...GLOBAL_OPTIONS, "session-root": { type: "string" }, "dry-run": { type: "boolean" } },
  list: { ...GLOBAL_OPTIONS, "session-root": { type: "string" } },
  minimize: {
    ...GLOBAL_OPTIONS,
    input: { type: "string" },
    test: { type: "string" },
    arg: { type: "string", multiple: true },
    args: { type: "string" },
    out: { type: "string" },
    budget: { type: "string" },
    timeout: { type: "string" },
    granularity: { type: "string" },
    noisy: { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  },
};

function protectMinimizerArgs(command: string, args: readonly string[]): string[] {
  if (command !== "minimize") return [...args];
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const next = args[i + 1];
    if (token === "--arg" && next !== undefined && next.startsWith("-")) {
      result.push(`--arg=${next}`);
      i++;
    } else {
      result.push(token);
    }
  }
  return result;
}

export function parseCommandArguments(argv: readonly string[]):
  | { readonly ok: true; readonly values: Readonly<Record<string, unknown>>; readonly positionals: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  const command = argv[0] === "run" ? "start" : argv[0];
  const options = command ? CLI_OPTION_TABLES[command] : undefined;
  if (!options) return { ok: true, values: {}, positionals: argv.slice(1) };
  try {
    const parsed = parseArgs({
      args: protectMinimizerArgs(command ?? "", argv.slice(1)),
      options,
      strict: true,
      allowPositionals: true,
    });
    return { ok: true, values: parsed.values, positionals: parsed.positionals };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `error: ${command}: ${message}` };
  }
}

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
    const val = Number(rawWarmup);
    if (!Number.isInteger(val) || val < 0) {
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
    const val = Number(rawSamples);
    if (!Number.isInteger(val) || val < 1) {
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
    const val = Number(rawMaxSamples);
    if (!Number.isInteger(val) || val < minSamples) {
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

export interface InlineCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function splitInlineCommand(argv: readonly string[]): {
  readonly bisectArgs: readonly string[];
  readonly inlineCommand?: InlineCommand;
} {
  const command = argv[0];
  if (command !== "plan" && command !== "start" && command !== "run") {
    return { bisectArgs: [...argv] };
  }

  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 0) {
    return { bisectArgs: [...argv] };
  }

  const tail = argv.slice(separatorIndex + 1);
  return {
    bisectArgs: argv.slice(0, separatorIndex),
    ...(tail.length > 0
      ? { inlineCommand: { command: tail[0]!, args: tail.slice(1) } }
      : {}),
  };
}

function readOptionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseInlineTimeout(
  args: readonly string[],
  defaultValue: number
): { ok: true; value: number } | { ok: false; error: string } {
  const index = args.indexOf("--timeout");
  if (index < 0) return { ok: true, value: defaultValue };
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) {
    return { ok: false, error: "Missing argument for --timeout <ms>" };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `Invalid --timeout "${raw}": must be a positive finite number` };
  }
  return { ok: true, value };
}

function applyInlineCommand(
  config: BisectConfigV1,
  inlineCommand: InlineCommand,
  timeoutMs: number
): BisectConfigV1 {
  return {
    ...config,
    oracle: {
      ...config.oracle,
      command: {
        ...config.oracle.command,
        command: inlineCommand.command,
        args: [...inlineCommand.args],
        timeoutMs,
      },
    },
  };
}

function createInlineConfig(
  args: readonly string[],
  inlineCommand: InlineCommand
): { ok: true; value: BisectConfigV1 } | { ok: false; error: string } {
  const goodRef = readOptionValue(args, "--good");
  const badRef = readOptionValue(args, "--bad");
  if (!goodRef || !badRef) {
    return {
      ok: false,
      error: "error: --good <ref> and --bad <ref> are required when --config is not provided",
    };
  }

  const starter = createStarterConfig(process.cwd());
  const timeout = parseInlineTimeout(args, starter.oracle.command.timeoutMs);
  if (!timeout.ok) return timeout;

  return {
    ok: true,
    value: applyInlineCommand(
      { ...starter, goodRef, badRef },
      inlineCommand,
      timeout.value
    ),
  };
}

function supportsColor(stream: NodeJS.WriteStream): boolean {
  return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;
}

function resultMarker(ok: boolean, stream: NodeJS.WriteStream): string {
  const marker = ok ? "OK" : "FAIL";
  if (!supportsColor(stream)) return marker;
  return `${ok ? "\u001b[32m" : "\u001b[31m"}${marker}\u001b[0m`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

async function getCommitSubject(repoRoot: string, sha: string): Promise<string | undefined> {
  const result = await runGit(["log", "-1", "--format=%s", sha], repoRoot);
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
  return redactSensitiveText(result.stdout.trim().split("\n", 1)[0]!);
}

async function formatCommitSummary(
  manifest: SessionManifestV1,
  label: string,
  sha: string
): Promise<string> {
  const subject = await getCommitSubject(manifest.repository.rootPath, sha);
  return `${label}: ${shortSha(sha)}${subject ? ` — ${subject}` : ""}`;
}

async function formatSessionSummary(manifest: SessionManifestV1): Promise<string> {
  const conclusion = manifest.conclusion;
  const outcome = conclusion?.outcome ?? manifest.state;
  const successful = outcome === "candidate_confirmed";
  const lines = [
    `Session: ${manifest.id}`,
    `Result: ${resultMarker(successful, process.stdout)}`,
    `State: ${manifest.state}`,
    `Outcome: ${outcome}`,
  ];

  if (conclusion?.candidateSha) {
    lines.push(await formatCommitSummary(manifest, "Candidate", conclusion.candidateSha));
  }
  if (conclusion?.parentSha) {
    lines.push(await formatCommitSummary(manifest, "Parent", conclusion.parentSha));
  }
  if (conclusion?.candidateRangeShas?.length) {
    lines.push(`Candidate range: ${conclusion.candidateRangeShas.map(shortSha).join(", ")}`);
  }

  lines.push(
    `Evaluated revisions: ${manifest.testedRevisions.length}`,
    `Skipped revisions: ${conclusion?.skippedShas.length ?? manifest.skipCount}`,
    `Summary: ${redactSensitiveText(conclusion?.explanation ?? "Session in progress.")}`
  );
  return lines.join("\n") + "\n";
}

function writeProgressEvent(event: LedgerEvent): void {
  let detail: string | undefined;
  switch (event.type) {
    case "session_created":
      detail = `session ${event.sessionId} created`;
      break;
    case "transition":
      detail = `state ${event.from} -> ${event.to}`;
      break;
    case "revision_classified":
      detail = `revision ${shortSha(event.commitSha)} classified ${event.classification}`;
      break;
    case "boundary_check":
      detail = `${event.target} boundary ${event.passedRuns}/${event.totalRuns} passed`;
      break;
    case "session_concluded":
      detail = `session concluded as ${event.conclusion.outcome}`;
      break;
    default:
      break;
  }
  if (detail) process.stderr.write(`[progress] ${detail}\n`);
}

export async function runCli(
  argv: readonly string[],
  engineOverride?: BisectEngine
): Promise<number> {
  const split = splitInlineCommand(argv);
  const args = [...split.bisectArgs];
  const inlineCommand = split.inlineCommand;
  const cmd = args[0];
  if (args.length === 0 || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("0.1.0\n");
    return 0;
  }

  if (cmd && cmd !== "daemon" && cmd !== "worker" && CLI_OPTION_TABLES[cmd]) {
    const parsed = parseCommandArguments(args);
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\n`);
      return 2;
    }
  }

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(commandHelp(cmd));
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("0.1.0\n");
    return 0;
  }

  const engine = engineOverride ?? new LocalBisectEngine();

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
    if (cfgIdx >= 0 && !cfgPath) {
      process.stderr.write("Missing --config <path>\n");
      return 2;
    }
    const goodIdx = args.indexOf("--good");
    const badIdx = args.indexOf("--bad");
    const termsIdx = args.indexOf("--terms");
    let activeConfig: BisectConfigV1;
    if (cfgPath) {
      const validated = loadConfigFromFile(cfgPath);
      if (!validated.ok) {
        process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
        return 2;
      }
      activeConfig = validated.value;
      if (inlineCommand) {
        const timeout = parseInlineTimeout(args, activeConfig.oracle.command.timeoutMs);
        if (!timeout.ok) {
          process.stderr.write(`${timeout.error}\n`);
          return 2;
        }
        activeConfig = applyInlineCommand(activeConfig, inlineCommand, timeout.value);
      }
    } else {
      if (!inlineCommand) {
        process.stderr.write(
          'error: provide an oracle command after "--" (e.g. bisectpilot start --good A --bad B -- npm test) or pass --config <file>\n'
        );
        return 2;
      }
      const inlineConfig = createInlineConfig(args, inlineCommand);
      if (!inlineConfig.ok) {
        process.stderr.write(`${inlineConfig.error}\n`);
        return 2;
      }
      activeConfig = inlineConfig.value;
    }
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
    if (cfgIdx >= 0 && !cfgPath) {
      process.stderr.write("Missing --config <path>\n");
      return 2;
    }
    const goodIdx = args.indexOf("--good");
    const badIdx = args.indexOf("--bad");
    const termsIdx = args.indexOf("--terms");
    let activeConfig: BisectConfigV1;
    if (cfgPath) {
      const validated = loadConfigFromFile(cfgPath);
      if (!validated.ok) {
        process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
        return 2;
      }
      activeConfig = validated.value;
      if (inlineCommand) {
        const timeout = parseInlineTimeout(args, activeConfig.oracle.command.timeoutMs);
        if (!timeout.ok) {
          process.stderr.write(`${timeout.error}\n`);
          return 2;
        }
        activeConfig = applyInlineCommand(activeConfig, inlineCommand, timeout.value);
      }
    } else {
      if (!inlineCommand) {
        process.stderr.write(
          'error: provide an oracle command after "--" (e.g. bisectpilot start --good A --bad B -- npm test) or pass --config <file>\n'
        );
        return 2;
      }
      const inlineConfig = createInlineConfig(args, inlineCommand);
      if (!inlineConfig.ok) {
        process.stderr.write(`${inlineConfig.error}\n`);
        return 2;
      }
      activeConfig = inlineConfig.value;
    }
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
        onEvent: writeProgressEvent,
      });
      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
      } else {
        process.stdout.write(await formatSessionSummary(manifest));
      }
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
        { abortSignal: abortController.signal, onEvent: writeProgressEvent },
        sessionRoot
      );
      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
      } else {
        process.stdout.write(await formatSessionSummary(manifest));
      }
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
    const rawBudget = budgetIdx >= 0 ? args[budgetIdx + 1] : undefined;
    const budget = rawBudget === undefined ? undefined : Number(rawBudget);
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
      process.stderr.write(`Invalid --budget "${rawBudget}": must be a positive integer\n`);
      return 2;
    }

    const timeoutIdx = args.indexOf("--timeout");
    const rawTimeout = timeoutIdx >= 0 ? args[timeoutIdx + 1] : undefined;
    const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      process.stderr.write(`Invalid --timeout "${rawTimeout}": must be a positive finite number\n`);
      return 2;
    }

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
