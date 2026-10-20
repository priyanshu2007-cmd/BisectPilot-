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

const DAEMON_COMMON_OPTIONS = {
  ...GLOBAL_OPTIONS,
  "state-dir": { type: "string" },
} as const;

const DAEMON_SERVICE_OPTIONS = {
  ...DAEMON_COMMON_OPTIONS,
  foreground: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "token-file": { type: "string" },
  "lease-ms": { type: "string" },
  "heartbeat-ms": { type: "string" },
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  "tls-ca": { type: "string" },
  "tls-require-client-cert": { type: "boolean" },
  "tls-allowed-identity": { type: "string", multiple: true },
  "tls-revoked-fingerprint": { type: "string", multiple: true },
  recover: { type: "boolean" },
} as const;

const WORKER_SERVICE_OPTIONS = {
  ...GLOBAL_OPTIONS,
  "state-dir": { type: "string" },
  foreground: { type: "boolean" },
  server: { type: "string" },
  "token-file": { type: "string" },
  repo: { type: "string", multiple: true },
  "poll-ms": { type: "string" },
  "heartbeat-ms": { type: "string" },
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  "tls-ca": { type: "string" },
  "tls-servername": { type: "string" },
  "worker-id": { type: "string" },
  recover: { type: "boolean" },
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
  daemon: DAEMON_COMMON_OPTIONS,
  "daemon:start": DAEMON_SERVICE_OPTIONS,
  "daemon:run": DAEMON_SERVICE_OPTIONS,
  "daemon:status": DAEMON_COMMON_OPTIONS,
  "daemon:stop": DAEMON_COMMON_OPTIONS,
  "daemon:enqueue": {
    ...DAEMON_COMMON_OPTIONS,
    config: { type: "string" },
    yes: { type: "boolean" },
    "repository-key": { type: "string" },
  },
  "daemon:cancel": { ...DAEMON_COMMON_OPTIONS, reason: { type: "string" } },
  "daemon:recover": { ...DAEMON_COMMON_OPTIONS, reason: { type: "string" } },
  "daemon:revoke": {
    ...DAEMON_COMMON_OPTIONS,
    fingerprint: { type: "string" },
    "worker-id": { type: "string" },
    reason: { type: "string" },
  },
  worker: { ...GLOBAL_OPTIONS, "state-dir": { type: "string" } },
  "worker:start": WORKER_SERVICE_OPTIONS,
  "worker:run": WORKER_SERVICE_OPTIONS,
  "worker:status": { ...GLOBAL_OPTIONS, "state-dir": { type: "string" } },
  "worker:stop": { ...GLOBAL_OPTIONS, "state-dir": { type: "string" } },
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
  | { readonly ok: true; readonly command?: string; readonly values: Readonly<Record<string, unknown>>; readonly positionals: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  let command = argv[0] === "run" ? "start" : argv[0] ?? "";
  let argsToParse = argv.slice(1);
  let optionsTable: CliOptionTable | undefined = CLI_OPTION_TABLES[command];

  if (command === "daemon" || command === "worker") {
    const subAction = argv[1];
    if (subAction && !subAction.startsWith("-")) {
      const subKey = `${command}:${subAction}`;
      if (CLI_OPTION_TABLES[subKey]) {
        command = `${command} ${subAction}`;
        optionsTable = CLI_OPTION_TABLES[subKey];
        argsToParse = argv.slice(2);
      }
    }
  }

  if (!optionsTable) {
    return { ok: true, command, values: {}, positionals: argv.slice(1) };
  }

  try {
    const parsed = parseArgs({
      args: protectMinimizerArgs(command, argsToParse),
      options: optionsTable,
      strict: true,
      allowPositionals: true,
    });
    return { ok: true, command, values: parsed.values, positionals: parsed.positionals };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `error: ${command}: ${message}` };
  }
}

export function parseBenchmarkCliOptions(
  argsOrValues: readonly string[] | Readonly<Record<string, unknown>>,
  existingBenchmark?: BenchmarkSpec
): { ok: true; benchmark?: BenchmarkSpec; profile?: RegressionProfile } | { ok: false; error: string } {
  const isValues = !Array.isArray(argsOrValues);
  const getOpt = (name: string): string | undefined => {
    if (isValues) {
      const v = (argsOrValues as Record<string, unknown>)[name];
      return typeof v === "string" ? v : undefined;
    }
    const idx = (argsOrValues as readonly string[]).indexOf(`--${name}`);
    const next = idx >= 0 ? (argsOrValues as readonly string[])[idx + 1] : undefined;
    return idx >= 0 && next && !next.startsWith("--") ? next : undefined;
  };
  const hasOpt = (name: string): boolean => {
    if (isValues) {
      return (argsOrValues as Record<string, unknown>)[name] !== undefined;
    }
    return (argsOrValues as readonly string[]).indexOf(`--${name}`) >= 0;
  };

  const rawMetric = getOpt("metric");
  if (hasOpt("metric") && !rawMetric) {
    return { ok: false, error: "Missing argument for --metric <name>" };
  }

  const rawThreshold = getOpt("threshold");
  let threshold: number | undefined = existingBenchmark?.threshold;
  if (hasOpt("threshold")) {
    if (!rawThreshold) {
      return { ok: false, error: "Missing argument for --threshold <number>" };
    }
    const val = Number(rawThreshold);
    if (!Number.isFinite(val)) {
      return { ok: false, error: `Invalid --threshold "${rawThreshold}": must be a finite number` };
    }
    threshold = val;
  }

  const rawRel = getOpt("relative-regression");
  let relativeRegression: number | undefined = existingBenchmark?.relativeRegression;
  if (hasOpt("relative-regression")) {
    if (!rawRel) {
      return { ok: false, error: "Missing argument for --relative-regression <val>" };
    }
    const cleanRel = rawRel.replace(/%$/, "").trim();
    const val = Number(cleanRel);
    if (!Number.isFinite(val) || val < 0) {
      return { ok: false, error: `Invalid --relative-regression "${rawRel}": must be a non-negative number` };
    }
    relativeRegression = val > 1.0 ? val / 100 : val;
  }

  const rawDir = getOpt("direction");
  let direction: BenchmarkDirection = existingBenchmark?.direction ?? "higher_is_worse";
  if (hasOpt("direction")) {
    if (!rawDir) {
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

  const rawWarmup = getOpt("warmup");
  let warmup = existingBenchmark?.warmup ?? 1;
  if (hasOpt("warmup")) {
    if (!rawWarmup) {
      return { ok: false, error: "Missing argument for --warmup <integer>" };
    }
    const val = Number(rawWarmup);
    if (!Number.isInteger(val) || val < 0) {
      return { ok: false, error: `Invalid --warmup "${rawWarmup}": must be an integer >= 0` };
    }
    warmup = val;
  }

  const rawSamples = getOpt("samples") ?? getOpt("min-samples");
  let minSamples = existingBenchmark?.minSamples ?? 3;
  if (hasOpt("samples") || hasOpt("min-samples")) {
    if (!rawSamples) {
      return { ok: false, error: "Missing argument for --samples / --min-samples <integer>" };
    }
    const val = Number(rawSamples);
    if (!Number.isInteger(val) || val < 1) {
      return { ok: false, error: `Invalid --samples "${rawSamples}": must be an integer >= 1` };
    }
    minSamples = val;
  }

  const rawMaxSamples = getOpt("max-samples");
  let maxSamples = existingBenchmark?.maxSamples ?? Math.max(10, minSamples);
  if (hasOpt("max-samples")) {
    if (!rawMaxSamples) {
      return { ok: false, error: "Missing argument for --max-samples <integer>" };
    }
    const val = Number(rawMaxSamples);
    if (!Number.isInteger(val) || val < minSamples) {
      return { ok: false, error: `Invalid --max-samples "${rawMaxSamples}": must be an integer >= minSamples (${minSamples})` };
    }
    maxSamples = val;
  }

  const rawAlpha = getOpt("alpha");
  let alpha = existingBenchmark?.alpha ?? 0.05;
  if (hasOpt("alpha")) {
    if (!rawAlpha) {
      return { ok: false, error: "Missing argument for --alpha <number>" };
    }
    const val = Number(rawAlpha);
    if (!Number.isFinite(val) || val <= 0 || val > 0.5) {
      return { ok: false, error: `Invalid --alpha "${rawAlpha}": must be a number between 0 and 0.5` };
    }
    alpha = val;
  }

  const rawUnit = getOpt("unit");
  let unit = existingBenchmark?.unit;
  if (hasOpt("unit")) {
    if (!rawUnit) {
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
  argsOrValues: readonly string[] | Readonly<Record<string, unknown>>,
  existing?: ContainerSandboxPolicy
): { ok: true; sandbox?: ContainerSandboxPolicy } | { ok: false; error: string } {
  const isValues = !Array.isArray(argsOrValues);
  const getOpt = (name: string): string | undefined => {
    if (isValues) {
      const v = (argsOrValues as Record<string, unknown>)[name];
      return typeof v === "string" ? v : undefined;
    }
    const idx = (argsOrValues as readonly string[]).indexOf(`--${name}`);
    const next = idx >= 0 ? (argsOrValues as readonly string[])[idx + 1] : undefined;
    return idx >= 0 && next && !next.startsWith("--") ? next : undefined;
  };
  const hasOpt = (name: string): boolean => {
    if (isValues) {
      return (argsOrValues as Record<string, unknown>)[name] !== undefined;
    }
    return (argsOrValues as readonly string[]).indexOf(`--${name}`) >= 0;
  };

  if (!hasOpt("sandbox") && !hasOpt("sandbox-image")) {
    return { ok: true, ...(existing ? { sandbox: existing } : {}) };
  }
  const rawRuntime = getOpt("sandbox") ?? existing?.runtime;
  const rawImage = getOpt("sandbox-image") ?? existing?.image;
  if (!rawRuntime) return { ok: false, error: "Missing argument for --sandbox <docker|podman>" };
  if (rawRuntime !== "docker" && rawRuntime !== "podman") return { ok: false, error: `Invalid --sandbox "${rawRuntime}": use docker or podman` };
  if (!rawImage) return { ok: false, error: "Sandbox mode requires --sandbox-image <repo@sha256:...> or execution.sandbox.image" };
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

function parseInlineTimeout(
  argsOrValues: readonly string[] | Readonly<Record<string, unknown>>,
  defaultValue: number
): { ok: true; value: number } | { ok: false; error: string } {
  let raw: unknown;
  let hasFlag = false;
  if (Array.isArray(argsOrValues)) {
    const idx = argsOrValues.indexOf("--timeout");
    if (idx >= 0) {
      hasFlag = true;
      raw = argsOrValues[idx + 1];
    }
  } else {
    if ((argsOrValues as Record<string, unknown>).timeout !== undefined) {
      hasFlag = true;
      raw = (argsOrValues as Record<string, unknown>).timeout;
    }
  }
  if (!hasFlag) return { ok: true, value: defaultValue };
  if (!raw || (typeof raw === "string" && raw.startsWith("--"))) {
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
  values: Readonly<Record<string, unknown>>,
  inlineCommand: InlineCommand
): { ok: true; value: BisectConfigV1 } | { ok: false; error: string } {
  const goodRef = values.good as string | undefined;
  const badRef = values.bad as string | undefined;
  if (!goodRef || !badRef) {
    return {
      ok: false,
      error: "error: --good <ref> and --bad <ref> are required when --config is not provided",
    };
  }

  const starter = createStarterConfig(process.cwd());
  const timeout = parseInlineTimeout(values, starter.oracle.command.timeoutMs);
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

  const parsed = parseCommandArguments(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
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

  if (cmd === "daemon") {
    try {
      return await runDaemonCommand(args.slice(1), engine);
    } catch (error: unknown) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
  }
  if (cmd === "worker") {
    try {
      return await runWorkerCommand(args.slice(1), engine);
    } catch (error: unknown) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
  }

  if (cmd === "doctor") {
    const report = await engine.doctor(parsed.positionals[0] ?? ".");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }

  if (cmd === "init") {
    const outPath = path.resolve((parsed.values.out as string | undefined) ?? "bisectpilot.config.json");
    if (existsSync(outPath) && !parsed.values.force) {
      process.stderr.write(`Config file already exists at ${outPath} (use --force to overwrite)\n`);
      return 2;
    }
    const starter = createStarterConfig(".");
    writeFileSync(outPath, JSON.stringify(starter, null, 2) + "\n", "utf-8");
    process.stdout.write(`Wrote starter config to ${outPath}\n`);
    return 0;
  }

  if (cmd === "plan") {
    const cfgPath = parsed.values.config as string | undefined;
    let activeConfig: BisectConfigV1;
    if (cfgPath) {
      const validated = loadConfigFromFile(cfgPath);
      if (!validated.ok) {
        process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
        return 2;
      }
      activeConfig = validated.value;
      if (inlineCommand) {
        const timeout = parseInlineTimeout(parsed.values, activeConfig.oracle.command.timeoutMs);
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
      const inlineConfig = createInlineConfig(parsed.values, inlineCommand);
      if (!inlineConfig.ok) {
        process.stderr.write(`${inlineConfig.error}\n`);
        return 2;
      }
      activeConfig = inlineConfig.value;
    }
    if (parsed.values.good) {
      activeConfig = { ...activeConfig, goodRef: parsed.values.good as string };
    }
    if (parsed.values.bad) {
      activeConfig = { ...activeConfig, badRef: parsed.values.bad as string };
    }
    if (parsed.values.terms) {
      const parsedTerms = parseTermsOption(parsed.values.terms as string);
      if (!parsedTerms.ok) {
        process.stderr.write(`Invalid --terms: ${parsedTerms.error}\n`);
        return 2;
      }
      activeConfig = { ...activeConfig, terms: parsedTerms.value };
    }
    if (parsed.values.cwd) {
      activeConfig = { ...activeConfig, workingDirectory: (parsed.values.cwd as string).trim() };
    }
    if (parsed.values.scope) {
      const scopes = (parsed.values.scope as string).split(",").map((s) => s.trim()).filter(Boolean);
      activeConfig = { ...activeConfig, pathScope: scopes };
    }
    const benchOpt = parseBenchmarkCliOptions(parsed.values, activeConfig.benchmark);
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
    const sandboxPlan = parseSandboxCliOptions(parsed.values, activeConfig.execution.sandbox);
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
    const cfgPath = parsed.values.config as string | undefined;
    const autoYes = Boolean(parsed.values.yes);
    let activeConfig: BisectConfigV1;
    if (cfgPath) {
      const validated = loadConfigFromFile(cfgPath);
      if (!validated.ok) {
        process.stderr.write(JSON.stringify(validated.issues, null, 2) + "\n");
        return 2;
      }
      activeConfig = validated.value;
      if (inlineCommand) {
        const timeout = parseInlineTimeout(parsed.values, activeConfig.oracle.command.timeoutMs);
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
      const inlineConfig = createInlineConfig(parsed.values, inlineCommand);
      if (!inlineConfig.ok) {
        process.stderr.write(`${inlineConfig.error}\n`);
        return 2;
      }
      activeConfig = inlineConfig.value;
    }
    if (parsed.values.good) {
      activeConfig = { ...activeConfig, goodRef: parsed.values.good as string };
    }
    if (parsed.values.bad) {
      activeConfig = { ...activeConfig, badRef: parsed.values.bad as string };
    }
    if (parsed.values.terms) {
      const parsedTerms = parseTermsOption(parsed.values.terms as string);
      if (!parsedTerms.ok) {
        process.stderr.write(`Invalid --terms: ${parsedTerms.error}\n`);
        return 2;
      }
      activeConfig = { ...activeConfig, terms: parsedTerms.value };
    }
    if (parsed.values.cwd) {
      activeConfig = { ...activeConfig, workingDirectory: (parsed.values.cwd as string).trim() };
    }
    if (parsed.values.scope) {
      const scopes = (parsed.values.scope as string).split(",").map((s) => s.trim()).filter(Boolean);
      activeConfig = { ...activeConfig, pathScope: scopes };
    }
    if (parsed.values.prompt) {
      activeConfig = {
        ...activeConfig,
        execution: {
          ...activeConfig.execution,
          interactivePrompt: true,
        },
      };
    }
    if (parsed.values.noisy) {
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
    const startBenchOpt = parseBenchmarkCliOptions(parsed.values, activeConfig.benchmark);
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
    const sandboxStart = parseSandboxCliOptions(parsed.values, activeConfig.execution.sandbox);
    if (!sandboxStart.ok) {
      process.stderr.write(`${sandboxStart.error}\n`);
      return 2;
    }
    if (sandboxStart.sandbox) activeConfig = { ...activeConfig, execution: { ...activeConfig.execution, sandbox: sandboxStart.sandbox } };
    if (parsed.values["github-summary"]) {
      const customPath = parsed.positionals[0];
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
    if (parsed.values.background) {
      const stateDir = path.resolve(
        (parsed.values["daemon-state-dir"] as string | undefined) ?? defaultDaemonStateDir()
      );
      const repositoryKey = (parsed.values["repository-key"] as string | undefined) ?? "default";
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
      if (parsed.values.json) {
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
    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const sessionRoot = parsed.values["session-root"] as string | undefined;
    const status = await engine.status(sessionId, sessionRoot);
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }

  if (cmd === "resume") {
    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const sessionRoot = parsed.values["session-root"] as string | undefined;
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
      if (parsed.values.json) {
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
    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const sessionRoot = parsed.values["session-root"] as string | undefined;
    const outPath = parsed.values.out as string | undefined;

    const status = await engine.status(sessionId, sessionRoot);
    const events = existsSync(status.manifest.ledgerPath)
      ? readLedgerEvents(status.manifest.ledgerPath)
      : [];

    if (parsed.values.verify) {
      const check = verifyLedgerChain(events);
      if (!check.valid) {
        process.stderr.write(`Ledger verification failed: ${check.reason}\n`);
        return 1;
      }
    }

    if (parsed.values["github-summary"]) {
      const customPath = parsed.positionals[1];
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

    if (parsed.values["github-issue"]) {
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

    if (parsed.values.html) {
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

    if (parsed.values.json) {
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
    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      process.stderr.write("Missing <sessionId>\n");
      return 2;
    }
    const dryRun = Boolean(parsed.values["dry-run"]);
    const sessionRoot = parsed.values["session-root"] as string | undefined;
    const res = await engine.cleanup(sessionId, { dryRun }, sessionRoot);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return 0;
  }

  if (cmd === "list") {
    const sessionRoot = parsed.values["session-root"] as string | undefined;
    const items = await engine.list(sessionRoot);
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
  }

  if (cmd === "minimize") {
    const inputPath = (parsed.values.input as string | undefined) ?? parsed.positionals[0];
    if (!inputPath) {
      process.stderr.write("Missing <inputPath> to minimize\n");
      return 2;
    }

    const testCmd = parsed.values.test as string | undefined;
    if (!testCmd) {
      process.stderr.write("Missing --test <command>\n");
      return 2;
    }

    const outputPath = parsed.values.out as string | undefined;

    const rawBudget = parsed.values.budget as string | undefined;
    const budget = rawBudget === undefined ? undefined : Number(rawBudget);
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
      process.stderr.write(`Invalid --budget "${rawBudget}": must be a positive integer\n`);
      return 2;
    }

    const rawTimeout = parsed.values.timeout as string | undefined;
    const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      process.stderr.write(`Invalid --timeout "${rawTimeout}": must be a positive finite number\n`);
      return 2;
    }

    const rawGran = parsed.values.granularity as string | undefined;
    const granularity: MinimizerGranularity | undefined =
      rawGran === "char" || rawGran === "both" || rawGran === "line" ? rawGran : undefined;

    let testArgs: string[] | undefined = (parsed.values.arg as string[] | undefined);
    if (!testArgs && parsed.values.args) {
      testArgs = (parsed.values.args as string).split(",").map((s) => s.trim());
    }

    const noisy = Boolean(parsed.values.noisy);
    const overwrite = Boolean(parsed.values.force);

    try {
      const localEngine = engine instanceof LocalBisectEngine ? engine : new LocalBisectEngine();
      const result = await localEngine.minimize({
        inputPath,
        outputPath,
        testCommand: testCmd,
        testArgs,
        timeoutMs,
        maxEvaluations: budget,
        granularity,
        noisy,
        overwriteOutput: overwrite,
      });

      if (parsed.values.json) {
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
