import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DETERMINISTIC_ENV_DEFAULTS,
  type LedgerEvent,
  type SessionManifestV1,
} from "../contracts/index.js";

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
  }>;
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
    }));

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
    limitations: [
      "A Git worktree isolates working files and bisect refs, not OS-level processes or network access.",
      "Non-monotonic commit histories may contain multiple transitions; boundary verification confirms the reported pair.",
    ],
  };
}

export function generateMarkdownReport(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const jsonReport = generateJsonReport(manifest, events);
  const badLabel = manifest.config.terms?.new ? `First ${manifest.config.terms.new}` : "First Bad";
  const classifiedRows = jsonReport.evaluations.map(
    (e) => {
      const noisyNote = e.noisySampling
        ? ` *(noisy: P(bad)=${e.noisySampling.posterior.toFixed(2)}, ${e.noisySampling.failedRuns}F/${e.noisySampling.passedRuns}P)*`
        : "";
      return `| \`${e.commitSha.slice(0, 8)}\` | **${e.classification}**${e.classifiedBy === "human" ? " *(manual)*" : ""}${noisyNote} | \`${e.reasonCode}\` | ${e.detail} |`;
    }
  );

  const lines = [
    `# BisectPilot Investigation Report — \`${manifest.id}\``,
    "",
    `- **Outcome:** \`${jsonReport.outcome}\``,
    `- **State:** \`${jsonReport.state}\``,
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

  return [
    "#!/usr/bin/env bash",
    "# ==============================================================================",
    `# BisectPilot Standalone Reproducibility Script — Session ${manifest.id}`,
    "# Generated for automated regression reproduction without altering caller state",
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
    `if (cd "$TMP_WT" && ${oracleCmd} >/dev/null 2>&1); then PARENT_RES="good"; else PARENT_RES="bad"; fi`,
    ...overlayRemoveCommands,
    "",
    'echo "Checking out candidate commit $CANDIDATE_SHA in isolated worktree..." >&2',
    'git -C "$TMP_WT" checkout --detach "$CANDIDATE_SHA" >/dev/null',
    ...overlayCopyCommands,
    `if (cd "$TMP_WT" && ${oracleCmd} >/dev/null 2>&1); then CANDIDATE_RES="good"; else CANDIDATE_RES="bad"; fi`,
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
  readonly reproScriptPath: string;
  readonly bisectLogPath?: string;
} {
  const dir = params.manifest.sessionDir;
  mkdirSync(dir, { recursive: true });

  const markdownPath = path.join(dir, "report.md");
  const jsonPath = path.join(dir, "report.json");
  const reproScriptPath = path.join(dir, "repro.sh");

  writeFileSync(markdownPath, generateMarkdownReport(params.manifest, params.events), "utf-8");
  writeFileSync(
    jsonPath,
    JSON.stringify(generateJsonReport(params.manifest, params.events), null, 2) + "\n",
    "utf-8"
  );
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

  return {
    markdownPath,
    jsonPath,
    reproScriptPath,
    ...(bisectLogPath ? { bisectLogPath } : {}),
  };
}

export * from "./replay-adapter.js";
