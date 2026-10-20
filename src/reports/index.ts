import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DETERMINISTIC_ENV_DEFAULTS,
  type LedgerEvent,
  type SessionManifestV1,
} from "../contracts/index.js";
import type { BenchmarkStats } from "../domain/benchmark.js";
import { resolveWorkspacePathScope } from "../domain/workspace.js";
import { generateHtmlReport } from "./html-report.js";
import { appendGitHubStepSummary, generateGitHubStepSummary } from "./github-summary.js";
import { defaultMetrics } from "../telemetry/index.js";

const SECRET_REPLACEMENTS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  { pattern: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\b(sk-[A-Za-z0-9_-]{20,})\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED_AWS_KEY_ID]" },
  { pattern: /(Authorization:\s*Bearer\s+)[^\s"']+/gi, replacement: "$1[REDACTED_BEARER]" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
];

export function redactSensitiveText(input: string): string {
  let out = input;
  const home = os.homedir();
  if (home && home.length > 1) {
    out = out.split(home).join("~");
  }
  for (const rule of SECRET_REPLACEMENTS) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

export interface SessionJsonReportV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly outcome: string;
  readonly state: SessionManifestV1["state"];
  readonly bounds: SessionManifestV1["bounds"];
  readonly terms?: { readonly old: string; readonly new: string };
  readonly candidateSha?: string;
  readonly parentSha?: string;
  readonly candidateRangeShas?: readonly string[];
  readonly skippedShas: readonly string[];
  readonly explanation: string;
  readonly overlayHashes: Readonly<Record<string, string>>;
  readonly deterministicEnvironment: Readonly<Record<string, string>>;
  readonly evaluations: ReadonlyArray<{
    readonly commitSha: string;
    readonly classification: string;
    readonly reasonCode: string;
    readonly detail: string;
    readonly gitExitCode: number;
    readonly classifiedBy?: "automated" | "human";
    readonly noisySampling?: {
      readonly sampleCount: number;
      readonly passedRuns: number;
      readonly failedRuns: number;
      readonly skippedRuns: number;
      readonly posterior: number;
      readonly confidenceThreshold: number;
    };
    readonly benchmark?: {
      readonly metric: string;
      readonly unit?: string;
      readonly sampleCount: number;
      readonly mean: number;
      readonly baselineMean?: number;
      readonly absoluteDelta?: number;
      readonly relativeDelta?: number;
      readonly pValue?: number;
      readonly isSignificant?: boolean;
      readonly isPracticalRegression?: boolean;
    };
  }>;
  readonly workingDirectory?: string;
  readonly pathScope?: readonly string[];
  readonly benchmark?: {
    readonly metric: string;
    readonly unit?: string;
    readonly baseline?: BenchmarkStats;
    readonly candidate?: BenchmarkStats;
    readonly absoluteDelta?: number;
    readonly relativeDelta?: number;
    readonly pValue?: number;
    readonly isSignificant?: boolean;
    readonly isPracticalRegression?: boolean;
  };
  readonly limitations: readonly string[];
}

export function generateJsonReport(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): SessionJsonReportV1 {
  const evaluations = events
    .filter((e): e is Extract<LedgerEvent, { type: "revision_classified" }> => e.type === "revision_classified")
    .map((e) => ({
      commitSha: e.commitSha,
      classification: e.classification,
      reasonCode: e.reasonCode,
      detail: redactSensitiveText(e.detail),
      gitExitCode: e.gitExitCode,
      ...(e.classifiedBy ? { classifiedBy: e.classifiedBy } : {}),
      ...(e.noisySampling ? { noisySampling: e.noisySampling } : {}),
      ...(e.benchmark ? { benchmark: e.benchmark } : {}),
    }));

  const effectivePathScope =
    manifest.config.pathScope ??
    resolveWorkspacePathScope(manifest.repository.rootPath, manifest.config.workingDirectory);

  let benchmarkSummary: SessionJsonReportV1["benchmark"] = undefined;
  if (manifest.benchmarkBaseline) {
    const candidateEvent = evaluations.find(
      (e) => (manifest.conclusion?.candidateSha && e.commitSha === manifest.conclusion.candidateSha) || e.classification === "bad"
    );
    benchmarkSummary = {
      metric: manifest.benchmarkBaseline.metric,
      unit: manifest.benchmarkBaseline.unit,
      baseline: manifest.benchmarkBaseline,
      ...(candidateEvent?.benchmark
        ? {
            candidate: {
              ...manifest.benchmarkBaseline,
              mean: candidateEvent.benchmark.mean,
              count: candidateEvent.benchmark.sampleCount,
            },
            absoluteDelta: candidateEvent.benchmark.absoluteDelta,
            relativeDelta: candidateEvent.benchmark.relativeDelta,
            pValue: candidateEvent.benchmark.pValue,
            isSignificant: candidateEvent.benchmark.isSignificant,
            isPracticalRegression: candidateEvent.benchmark.isPracticalRegression,
          }
        : {}),
    };
  }

  return {
    schemaVersion: 1,
    sessionId: manifest.id,
    outcome: manifest.conclusion?.outcome ?? manifest.state,
    state: manifest.state,
    bounds: manifest.bounds,
    ...(manifest.config.terms ? { terms: manifest.config.terms } : {}),
    ...(manifest.conclusion?.candidateSha ? { candidateSha: manifest.conclusion.candidateSha } : {}),
    ...(manifest.conclusion?.parentSha ? { parentSha: manifest.conclusion.parentSha } : {}),
    ...(manifest.conclusion?.candidateRangeShas
      ? { candidateRangeShas: manifest.conclusion.candidateRangeShas }
      : {}),
    skippedShas: manifest.conclusion?.skippedShas ?? [],
    explanation: redactSensitiveText(manifest.conclusion?.explanation ?? "Session in progress."),
    overlayHashes: manifest.overlayHashes,
    deterministicEnvironment: DETERMINISTIC_ENV_DEFAULTS,
    evaluations,
    ...(manifest.config.workingDirectory && manifest.config.workingDirectory !== "."
      ? { workingDirectory: manifest.config.workingDirectory }
      : {}),
    ...(effectivePathScope ? { pathScope: effectivePathScope } : {}),
    ...(benchmarkSummary ? { benchmark: benchmarkSummary } : {}),
    limitations: [
      "A Git worktree isolates working files and bisect refs, not OS-level processes or network access.",
      "Non-monotonic commit histories may contain multiple transitions; boundary verification confirms the reported pair.",
    ],
  };
}

export interface CollapsedEvaluation {
  readonly commitSha: string;
  readonly runCount: number;
  readonly unanimous: boolean;
  readonly classificationSummary: string;
  readonly primaryClassification: string;
  readonly reasonCode: string;
  readonly detail: string;
  readonly classifiedBy?: "automated" | "human";
  readonly noisySampling?: SessionJsonReportV1["evaluations"][number]["noisySampling"];
  readonly benchmark?: SessionJsonReportV1["evaluations"][number]["benchmark"];
  readonly runs: readonly SessionJsonReportV1["evaluations"][number][];
}

export function collapseConsecutiveEvaluations(
  evaluations: readonly SessionJsonReportV1["evaluations"][number][]
): CollapsedEvaluation[] {
  const groups: SessionJsonReportV1["evaluations"][number][][] = [];
  for (const ev of evaluations) {
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup[0]!.commitSha === ev.commitSha) {
      currentGroup.push(ev);
    } else {
      groups.push([ev]);
    }
  }

  return groups.map((group) => {
    const first = group[0]!;
    if (group.length === 1) {
      return {
        commitSha: first.commitSha,
        runCount: 1,
        unanimous: true,
        classificationSummary: first.classification,
        primaryClassification: first.classification,
        reasonCode: first.reasonCode,
        detail: first.detail,
        classifiedBy: first.classifiedBy,
        noisySampling: first.noisySampling,
        benchmark: first.benchmark,
        runs: group,
      };
    }

    const total = group.length;
    const counts = new Map<string, number>();
    for (const ev of group) {
      counts.set(ev.classification, (counts.get(ev.classification) ?? 0) + 1);
    }

    const uniqueClasses = [...counts.keys()];
    const unanimous = uniqueClasses.length === 1;

    let classificationSummary: string;
    let primaryClassification: string;
    if (unanimous) {
      const cls = uniqueClasses[0]!;
      classificationSummary = `${cls} · ${total}/${total} runs`;
      primaryClassification = cls;
    } else {
      const parts = [...counts.entries()].map(([cls, count]) => `${count}/${total} ${cls}`);
      classificationSummary = parts.join(", ");
      primaryClassification = "mixed";
    }

    const uniqueReasons = [...new Set(group.map((g) => g.reasonCode))];
    const uniqueDetails = [...new Set(group.map((g) => g.detail).filter(Boolean))];

    const hasHuman = group.some((g) => g.classifiedBy === "human");
    const lastWithNoisy = [...group].reverse().find((g) => g.noisySampling);
    const lastWithBench = [...group].reverse().find((g) => g.benchmark);

    return {
      commitSha: first.commitSha,
      runCount: total,
      unanimous,
      classificationSummary,
      primaryClassification,
      reasonCode: uniqueReasons.join(", "),
      detail: uniqueDetails.join("; ") || "-",
      classifiedBy: hasHuman ? "human" : undefined,
      noisySampling: lastWithNoisy?.noisySampling,
      benchmark: lastWithBench?.benchmark,
      runs: group,
    };
  });
}

export function generateMarkdownReport(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const jsonReport = generateJsonReport(manifest, events);
  const badLabel = manifest.config.terms?.new ? `First ${manifest.config.terms.new}` : "First Bad";
  const collapsed = collapseConsecutiveEvaluations(jsonReport.evaluations);
  const classifiedRows = collapsed.map(
    (e) => {
      const noisyNote = e.noisySampling
        ? ` *(noisy: P(bad)=${e.noisySampling.posterior.toFixed(2)}, ${e.noisySampling.failedRuns}F/${e.noisySampling.passedRuns}P)*`
        : "";
      const benchNote = e.benchmark
        ? ` *(mean: ${e.benchmark.mean.toFixed(1)}${e.benchmark.unit ? " " + e.benchmark.unit : ""}${e.benchmark.relativeDelta !== undefined ? `, ${e.benchmark.relativeDelta >= 0 ? "+" : ""}${(e.benchmark.relativeDelta * 100).toFixed(1)}%` : ""})*`
        : "";
      return `| \`${e.commitSha.slice(0, 8)}\` | **${e.classificationSummary}**${e.classifiedBy === "human" ? " *(manual)*" : ""}${noisyNote}${benchNote} | \`${e.reasonCode}\` | ${e.detail} |`;
    }
  );

  const lines = [
    `# BisectPilot Investigation Report — \`${manifest.id}\``,
    "",
    `- **Outcome:** \`${jsonReport.outcome}\``,
    `- **State:** \`${jsonReport.state}\``,
    ...(manifest.config.workingDirectory && manifest.config.workingDirectory !== "."
      ? [`- **Workspace Directory:** \`${manifest.config.workingDirectory}\``]
      : []),
    ...(jsonReport.pathScope
      ? [`- **Path Scope:** ${jsonReport.pathScope.map((p) => `\`${p}\``).join(", ")}`]
      : []),
    ...(manifest.config.terms
      ? [`- **Bisect Terms:** \`${manifest.config.terms.old}\` (old/good) / \`${manifest.config.terms.new}\` (new/bad)`]
      : []),
    `- **Good Endpoint:** \`${manifest.bounds.goodSha}\` (${manifest.bounds.goodInputRef})`,
    `- **Bad Endpoint:** \`${manifest.bounds.badSha}\` (${manifest.bounds.badInputRef})`,
    ...(jsonReport.candidateSha
      ? [`- **Suspected ${badLabel} Commit:** \`${jsonReport.candidateSha}\``]
      : []),
    ...(jsonReport.parentSha ? [`- **Verified Good Parent:** \`${jsonReport.parentSha}\``] : []),
    `- **Summary:** ${jsonReport.explanation}`,
    ...(jsonReport.benchmark
      ? [
          "",
          "## Benchmark Performance Summary",
          "",
          `- **Metric:** \`${jsonReport.benchmark.metric}\`${jsonReport.benchmark.unit ? ` (${jsonReport.benchmark.unit})` : ""}`,
          ...(jsonReport.benchmark.baseline
            ? [`- **Baseline Mean:** \`${jsonReport.benchmark.baseline.mean.toFixed(2)}\` (p50: \`${jsonReport.benchmark.baseline.median.toFixed(2)}\`, p95: \`${jsonReport.benchmark.baseline.p95.toFixed(2)}\`, p99: \`${jsonReport.benchmark.baseline.p99.toFixed(2)}\`, stdDev: \`${jsonReport.benchmark.baseline.stdDev.toFixed(2)}\`)`]
            : []),
          ...(jsonReport.benchmark.candidate
            ? [`- **Candidate Mean:** \`${jsonReport.benchmark.candidate.mean.toFixed(2)}\``]
            : []),
          ...(jsonReport.benchmark.relativeDelta !== undefined
            ? [`- **Shift:** \`${jsonReport.benchmark.relativeDelta >= 0 ? "+" : ""}${(jsonReport.benchmark.relativeDelta * 100).toFixed(2)}%\` (\`${jsonReport.benchmark.absoluteDelta !== undefined && jsonReport.benchmark.absoluteDelta >= 0 ? "+" : ""}${jsonReport.benchmark.absoluteDelta?.toFixed(2) ?? "0"}\`)`]
            : []),
          ...(jsonReport.benchmark.pValue !== undefined
            ? [`- **Statistical Significance:** Welch's t-test p = \`${jsonReport.benchmark.pValue.toFixed(5)}\` (${jsonReport.benchmark.isSignificant ? "Statistically Significant" : "Not Significant"})`]
            : []),
        ]
      : []),
    "",
    "## Evaluated Revisions",
    "",
    "| Commit | Classification | Reason Code | Detail |",
    "|---|---|---|---|",
    ...(classifiedRows.length > 0 ? classifiedRows : ["| (none) | - | - | - |"]),
    "",
    "## Limitations & Safety Note",
    "",
    ...jsonReport.limitations.map((item) => `- ${item}`),
  ];
  return lines.join("\n") + "\n";
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function generateReproScript(manifest: SessionManifestV1): string {
  const candidate = manifest.conclusion?.candidateSha ?? manifest.bounds.badSha;
  const parent = manifest.conclusion?.parentSha ?? manifest.bounds.goodSha;
  const oracleCmd = [manifest.config.oracle.command.command, ...manifest.config.oracle.command.args]
    .map(shQuote)
    .join(" ");

  const overlayCopyCommands =
    manifest.config.oracle.mode === "overlay" && manifest.config.oracle.overlayFiles
      ? manifest.config.oracle.overlayFiles.map(
          (rel) =>
            `mkdir -p "$(dirname "$TMP_WT/${rel}")" && cp ${shQuote(path.join(manifest.sessionDir, "overlays", rel))} "$TMP_WT/${rel}"`
        )
      : [];
  const overlayRemoveCommands =
    manifest.config.oracle.mode === "overlay" && manifest.config.oracle.overlayFiles
      ? manifest.config.oracle.overlayFiles.map((rel) => `rm -f "$TMP_WT/${rel}"`)
      : [];

  const workDirRel =
    manifest.config.workingDirectory && manifest.config.workingDirectory !== "."
      ? manifest.config.workingDirectory.replace(/\\/g, "/").replace(/^\.\//, "")
      : "";
  const cdTarget = workDirRel ? `"$TMP_WT/${workDirRel}"` : `"$TMP_WT"`;

  return [
    "#!/usr/bin/env bash",
    "# ==============================================================================",
    `# BisectPilot Standalone Reproducibility Script — Session ${manifest.id}`,
    "# Generated for automated regression reproduction without altering caller state",
    ...(workDirRel ? [`# Target Workspace: ${manifest.config.workingDirectory}`] : []),
    `# Reference Ledger: ${manifest.ledgerPath}`,
    `# Reference Report: ${path.join(manifest.sessionDir, "report.json")}`,
    "# ==============================================================================",
    "set -euo pipefail",
    "",
    `REPO_ROOT=${shQuote(manifest.repository.rootPath)}`,
    `PARENT_SHA=${shQuote(parent)}`,
    `CANDIDATE_SHA=${shQuote(candidate)}`,
    "",
    "# 1. Prerequisite checks",
    'if ! command -v git >/dev/null 2>&1; then',
    '  echo "Error: git is required but not installed or not in PATH." >&2',
    '  exit 2',
    'fi',
    'if [ ! -d "$REPO_ROOT" ]; then',
    '  echo "Error: Repository directory does not exist: $REPO_ROOT" >&2',
    '  exit 2',
    'fi',
    'if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then',
    '  echo "Error: Directory is not a git repository: $REPO_ROOT" >&2',
    '  exit 2',
    'fi',
    'if ! git -C "$REPO_ROOT" cat-file -e "$PARENT_SHA^{commit}" >/dev/null 2>&1; then',
    '  echo "Error: Parent commit not found: $PARENT_SHA" >&2',
    '  exit 2',
    'fi',
    'if ! git -C "$REPO_ROOT" cat-file -e "$CANDIDATE_SHA^{commit}" >/dev/null 2>&1; then',
    '  echo "Error: Candidate commit not found: $CANDIDATE_SHA" >&2',
    '  exit 2',
    'fi',
    "",
    "# 2. Deterministic execution environment defaults (Section 26.8)",
    'export CI="1"',
    'export TZ="UTC"',
    'export LANG="C.UTF-8"',
    'export NO_COLOR="1"',
    'export FORCE_COLOR="0"',
    'export npm_config_audit="false"',
    'export npm_config_fund="false"',
    'export npm_config_update_notifier="false"',
    "",
    "# 3. Isolated worktree setup",
    'TMP_WT="$(mktemp -d "${TMPDIR:-/tmp}/bp-repro-XXXXXX")"',
    'cleanup() {',
    '  git -C "$REPO_ROOT" worktree remove --force "$TMP_WT" >/dev/null 2>&1 || rm -rf "$TMP_WT"',
    '}',
    'trap cleanup EXIT',
    "",
    'echo "Checking out parent commit $PARENT_SHA in isolated worktree..." >&2',
    'git -C "$REPO_ROOT" worktree add --detach "$TMP_WT" "$PARENT_SHA" >/dev/null',
    ...overlayCopyCommands,
    `if (cd ${cdTarget} && ${oracleCmd} >/dev/null 2>&1); then PARENT_RES="good"; else PARENT_RES="bad"; fi`,
    ...overlayRemoveCommands,
    "",
    'echo "Checking out candidate commit $CANDIDATE_SHA in isolated worktree..." >&2',
    'git -C "$TMP_WT" checkout --detach "$CANDIDATE_SHA" >/dev/null',
    ...overlayCopyCommands,
    `if (cd ${cdTarget} && ${oracleCmd} >/dev/null 2>&1); then CANDIDATE_RES="good"; else CANDIDATE_RES="bad"; fi`,
    ...overlayRemoveCommands,
    "",
    "# 4. Final outcome contract: parent: <result>, candidate: <result>",
    'echo "parent: ${PARENT_RES}, candidate: ${CANDIDATE_RES}"',
    'if [ "$PARENT_RES" = "good" ] && [ "$CANDIDATE_RES" = "bad" ]; then',
    '  exit 0',
    'else',
    '  exit 1',
    'fi',
    "",
  ].join("\n");
}

export function writeSessionReportArtifacts(params: {
  readonly manifest: SessionManifestV1;
  readonly events: readonly LedgerEvent[];
  readonly bisectLogText?: string;
}): {
  readonly markdownPath: string;
  readonly jsonPath: string;
  readonly htmlPath: string;
  readonly reproScriptPath: string;
  readonly bisectLogPath?: string;
  readonly githubSummaryAppended?: boolean;
} {
  const dir = params.manifest.sessionDir;
  mkdirSync(dir, { recursive: true });

  const markdownPath = path.join(dir, "report.md");
  const jsonPath = path.join(dir, "report.json");
  const htmlPath = path.join(dir, "report.html");
  const reproScriptPath = path.join(dir, "repro.sh");

  try {
    writeFileSync(markdownPath, generateMarkdownReport(params.manifest, params.events), "utf-8");
  } catch (error) {
    defaultMetrics.reportGenerationFailuresTotal.inc({ format: "markdown" });
    throw error;
  }
  try {
    writeFileSync(
      jsonPath,
      JSON.stringify(generateJsonReport(params.manifest, params.events), null, 2) + "\n",
      "utf-8"
    );
  } catch (error) {
    defaultMetrics.reportGenerationFailuresTotal.inc({ format: "json" });
    throw error;
  }
  try {
    writeFileSync(htmlPath, generateHtmlReport(params.manifest, params.events), "utf-8");
  } catch (error) {
    defaultMetrics.reportGenerationFailuresTotal.inc({ format: "html" });
    throw error;
  }
  writeFileSync(reproScriptPath, generateReproScript(params.manifest), "utf-8");
  try {
    chmodSync(reproScriptPath, 0o755);
  } catch {
    // Ignore chmod on unsupported filesystems
  }

  let bisectLogPath: string | undefined;
  if (params.bisectLogText) {
    bisectLogPath = path.join(dir, "bisect.log");
    writeFileSync(bisectLogPath, params.bisectLogText + "\n", "utf-8");
  }

  let githubSummaryAppended = false;
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryMd = generateGitHubStepSummary(params.manifest, params.events);
    const res = appendGitHubStepSummary(summaryMd);
    githubSummaryAppended = res.written;
  }

  return {
    markdownPath,
    jsonPath,
    htmlPath,
    reproScriptPath,
    ...(bisectLogPath ? { bisectLogPath } : {}),
    ...(githubSummaryAppended ? { githubSummaryAppended: true } : {}),
  };
}

export * from "./replay-adapter.js";
export * from "./html-report.js";
export * from "./github-summary.js";
