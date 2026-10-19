import os from "node:os";
import type { LedgerEvent, SessionManifestV1 } from "../contracts/index.js";

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

export function generateMarkdownReport(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const outcomeTitle = manifest.conclusion?.outcome ?? manifest.state;
  const classifiedRows = events
    .filter((e): e is Extract<LedgerEvent, { type: "revision_classified" }> => e.type === "revision_classified")
    .map(
      (e) =>
        `| \`${e.commitSha.slice(0, 8)}\` | **${e.classification}** | \`${e.reasonCode}\` | ${redactSensitiveText(e.detail)} |`
    );

  const lines = [
    `# BisectPilot Investigation Report — \`${manifest.id}\``,
    "",
    `- **Outcome:** \`${outcomeTitle}\``,
    `- **State:** \`${manifest.state}\``,
    `- **Good Endpoint:** \`${manifest.bounds.goodSha}\` (${manifest.bounds.goodInputRef})`,
    `- **Bad Endpoint:** \`${manifest.bounds.badSha}\` (${manifest.bounds.badInputRef})`,
    ...(manifest.conclusion?.candidateSha
      ? [`- **Suspected First Bad Commit:** \`${manifest.conclusion.candidateSha}\``]
      : []),
    ...(manifest.conclusion?.parentSha
      ? [`- **Verified Good Parent:** \`${manifest.conclusion.parentSha}\``]
      : []),
    `- **Summary:** ${redactSensitiveText(manifest.conclusion?.explanation ?? "Session in progress.")}`,
    "",
    "## Evaluated Revisions",
    "",
    "| Commit | Classification | Reason Code | Detail |",
    "|---|---|---|---|",
    ...(classifiedRows.length > 0 ? classifiedRows : ["| (none) | - | - | - |"]),
    "",
    "## Limitations & Safety Note",
    "",
    "- A Git worktree isolates working files and bisect refs, not OS-level processes or network access.",
    "- Non-monotonic commit histories may contain multiple transitions; boundary verification confirms the reported pair.",
  ];
  return lines.join("\n") + "\n";
}

export function generateReproScript(manifest: SessionManifestV1): string {
  const candidate = manifest.conclusion?.candidateSha ?? manifest.bounds.badSha;
  const parent = manifest.conclusion?.parentSha ?? manifest.bounds.goodSha;
  const cmd = [manifest.config.oracle.command.command, ...manifest.config.oracle.command.args]
    .map((part) => JSON.stringify(part))
    .join(" ");

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# Reproducibility script for BisectPilot session ${manifest.id}`,
    `REPO_ROOT=${JSON.stringify(manifest.repository.rootPath)}`,
    `PARENT_SHA=${JSON.stringify(parent)}`,
    `CANDIDATE_SHA=${JSON.stringify(candidate)}`,
    'TMP_WT="$(mktemp -d "${TMPDIR:-/tmp}/bp-repro-XXXXXX")"',
    'cleanup() { git -C "$REPO_ROOT" worktree remove --force "$TMP_WT" >/dev/null 2>&1 || rm -rf "$TMP_WT"; }',
    "trap cleanup EXIT",
    'git -C "$REPO_ROOT" worktree add --detach "$TMP_WT" "$PARENT_SHA" >/dev/null',
    `if (cd "$TMP_WT" && ${cmd} >/dev/null 2>&1); then PARENT_RES="good"; else PARENT_RES="bad"; fi`,
    'git -C "$TMP_WT" checkout --detach "$CANDIDATE_SHA" >/dev/null',
    `if (cd "$TMP_WT" && ${cmd} >/dev/null 2>&1); then CANDIDATE_RES="good"; else CANDIDATE_RES="bad"; fi`,
    'echo "parent: ${PARENT_RES}, candidate: ${CANDIDATE_RES}"',
    "",
  ].join("\n");
}
