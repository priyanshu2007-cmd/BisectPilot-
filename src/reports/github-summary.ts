import { appendFileSync } from "node:fs";
import type { LedgerEvent, SessionManifestV1 } from "../contracts/index.js";
import { verifyLedgerChain } from "../ledger/index.js";
import { collapseConsecutiveEvaluations, generateJsonReport, redactSensitiveText } from "./index.js";

/**
 * Generate a GitHub Actions Step Summary in GitHub-Flavored Markdown.
 * Designed to be appended to $GITHUB_STEP_SUMMARY.
 */
export function generateGitHubStepSummary(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const jsonReport = generateJsonReport(manifest, events);
  const ledgerCheck = verifyLedgerChain(events);
  const outcome = jsonReport.outcome;

  let outcomeBadge = "🔍";
  if (outcome === "candidate_confirmed" || outcome === "candidate_found") {
    outcomeBadge = "🎯";
  } else if (outcome === "candidate_ambiguous") {
    outcomeBadge = "⚠️";
  } else if (outcome === "inconclusive" || outcome === "skipped") {
    outcomeBadge = "❓";
  } else if (outcome.includes("failed") || outcome === "cancelled") {
    outcomeBadge = "❌";
  }

  const badTerm = manifest.config.terms?.new ? `First ${manifest.config.terms.new}` : "First Bad";
  const goodTerm = manifest.config.terms?.old ? `Last ${manifest.config.terms.old}` : "Last Good";

  const lines: string[] = [
    `# ${outcomeBadge} BisectPilot Investigation Summary`,
    "",
    `> **Session ID:** \`${manifest.id}\` &nbsp;|&nbsp; **Outcome:** \`${outcome}\` &nbsp;|&nbsp; **Evaluations:** ${jsonReport.evaluations.length} commits`,
    "",
    "### 📋 Key Findings",
    "",
    "| Property | Value |",
    "|---|---|",
    `| **Outcome** | \`${outcome}\` |`,
    ...(jsonReport.candidateSha
      ? [`| **Suspected ${badTerm} Commit** | \`${jsonReport.candidateSha}\` |`]
      : []),
    ...(jsonReport.parentSha
      ? [`| **Verified ${goodTerm} Parent** | \`${jsonReport.parentSha}\` |`]
      : []),
    ...(jsonReport.candidateRangeShas && jsonReport.candidateRangeShas.length > 1
      ? [
          `| **Candidate Range** | \`${jsonReport.candidateRangeShas[0]}\` .. \`${jsonReport.candidateRangeShas[jsonReport.candidateRangeShas.length - 1]}\` (${jsonReport.candidateRangeShas.length} commits) |`,
        ]
      : []),
    `| **Good Endpoint** | \`${manifest.bounds.goodSha.slice(0, 8)}\` (${manifest.bounds.goodInputRef}) |`,
    `| **Bad Endpoint** | \`${manifest.bounds.badSha.slice(0, 8)}\` (${manifest.bounds.badInputRef}) |`,
    ...(manifest.config.terms
      ? [
          `| **Bisect Terms** | Old: \`${manifest.config.terms.old}\` / New: \`${manifest.config.terms.new}\` |`,
        ]
      : []),
    ...(manifest.config.workingDirectory && manifest.config.workingDirectory !== "."
      ? [`| **Workspace Directory** | \`${manifest.config.workingDirectory}\` |`]
      : []),
    ...(manifest.config.pathScope
      ? [`| **Path Scope** | ${manifest.config.pathScope.map((p) => `\`${p}\``).join(", ")} |`]
      : []),
    ...(jsonReport.benchmark
      ? [
          `| **Benchmark Metric** | \`${jsonReport.benchmark.metric}\`${jsonReport.benchmark.unit ? ` (${jsonReport.benchmark.unit})` : ""}: ${jsonReport.benchmark.baseline ? `base ${jsonReport.benchmark.baseline.mean.toFixed(1)}` : ""} &rarr; ${jsonReport.benchmark.candidate ? `cand ${jsonReport.benchmark.candidate.mean.toFixed(1)}` : ""} (${jsonReport.benchmark.relativeDelta !== undefined ? `${jsonReport.benchmark.relativeDelta >= 0 ? "+" : ""}${(jsonReport.benchmark.relativeDelta * 100).toFixed(1)}%` : ""}, p=${jsonReport.benchmark.pValue !== undefined ? jsonReport.benchmark.pValue.toFixed(4) : "N/A"}) |`,
        ]
      : []),
    `| **Ledger Integrity** | ${

      ledgerCheck.valid
        ? `✅ Hash chain verified (${events.length} events)`
        : `⚠️ Verification failed (${ledgerCheck.reason})`
    } |`,
    "",
    `**Summary:** ${jsonReport.explanation}`,
    "",
  ];

  if (jsonReport.evaluations.length > 0) {
    lines.push(
      "### 🔍 Evaluated Revisions",
      "",
      "<details open>",
      `<summary><b>Classification Timeline (${jsonReport.evaluations.length} commits)</b></summary>`,
      "",
      "| Commit | Classification | Reason Code | Details |",
      "|---|---|---|---|"
    );

    const collapsed = collapseConsecutiveEvaluations(jsonReport.evaluations);
    for (const ev of collapsed) {
      const shortSha = ev.commitSha.slice(0, 8);
      const manualTag = ev.classifiedBy === "human" ? " *(manual)*" : "";
      const noisyTag = ev.noisySampling
        ? ` *(noisy: P(bad)=${ev.noisySampling.posterior.toFixed(2)}, ${ev.noisySampling.failedRuns}F/${ev.noisySampling.passedRuns}P)*`
        : "";
      const cleanDetail = redactSensitiveText(ev.detail || "-").replace(/\|/g, "\\|");
      lines.push(
        `| \`${shortSha}\` | **${ev.classificationSummary}**${manualTag}${noisyTag} | \`${ev.reasonCode}\` | ${cleanDetail} |`
      );
    }

    lines.push("</details>", "");
  }

  lines.push(
    "### 🔁 Local Reproduction",
    "",
    "To reproduce this finding locally in an isolated temporary worktree without modifying working files:",
    "",
    "```bash",
    `bash .bisectpilot/sessions/${manifest.id}/repro.sh`,
    "```",
    "",
    "### ⚠️ Notes & Limitations",
    ""
  );

  for (const lim of jsonReport.limitations) {
    lines.push(`- ${lim}`);
  }

  lines.push(
    "",
    "---",
    `*Generated by BisectPilot v${manifest.runnerVersion} • Hash-chain audited*`
  );

  return lines.join("\n") + "\n";
}

/**
 * Generate a Markdown report formatted for pasting into a GitHub Issue or Pull Request description.
 */
export function generateGitHubIssueMarkdown(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const jsonReport = generateJsonReport(manifest, events);
  const badTerm = manifest.config.terms?.new ? `First ${manifest.config.terms.new}` : "First Bad";
  const candidate = jsonReport.candidateSha;

  const lines: string[] = [
    `## 🐛 Regression Report — Suspected ${badTerm} Commit: \`${candidate ?? "Unknown"}\``,
    "",
    "### Summary",
    "",
    `BisectPilot identified \`${candidate ?? "an inconclusive outcome"}\` while investigating regression between ` +
      `\`${manifest.bounds.goodSha.slice(0, 8)}\` (${manifest.bounds.goodInputRef}) and ` +
      `\`${manifest.bounds.badSha.slice(0, 8)}\` (${manifest.bounds.badInputRef}).`,
    "",
    `- **Outcome:** \`${jsonReport.outcome}\``,
    ...(candidate ? [`- **Suspected ${badTerm} Commit:** \`${candidate}\``] : []),
    ...(jsonReport.parentSha ? [`- **Verified Good Parent:** \`${jsonReport.parentSha}\``] : []),
    ...(manifest.config.workingDirectory && manifest.config.workingDirectory !== "."
      ? [`- **Workspace Directory:** \`${manifest.config.workingDirectory}\``]
      : []),
    ...(manifest.config.pathScope
      ? [`- **Path Scope:** ${manifest.config.pathScope.map((p) => `\`${p}\``).join(", ")}`]
      : []),
    `- **Oracle Command:** \`${manifest.config.oracle.command.command} ${manifest.config.oracle.command.args.join(" ")}\``,
    `- **Explanation:** ${jsonReport.explanation}`,
    "",
    "### Bisection Timeline & Evidence",
    "",
    "<details>",
    `<summary>Click to view ${jsonReport.evaluations.length} evaluated revisions</summary>`,
    "",
    "| Commit | Classification | Reason Code | Details |",
    "|---|---|---|---|"
  ];

  const collapsed = collapseConsecutiveEvaluations(jsonReport.evaluations);
  for (const ev of collapsed) {
    const shortSha = ev.commitSha.slice(0, 8);
    const manualTag = ev.classifiedBy === "human" ? " *(manual)*" : "";
    const cleanDetail = redactSensitiveText(ev.detail || "-").replace(/\|/g, "\\|");
    lines.push(`| \`${shortSha}\` | **${ev.classificationSummary}**${manualTag} | \`${ev.reasonCode}\` | ${cleanDetail} |`);
  }

  lines.push(
    "",
    "</details>",
    "",
    "### Local Reproduction",
    "",
    "Run the self-contained reproduction script in an isolated worktree:",
    "",
    "```bash",
    `bash .bisectpilot/sessions/${manifest.id}/repro.sh`,
    "```",
    "",
    "---",
    `*Reported by [BisectPilot](https://github.com/priyanshu2007-cmd/BisectPilot-) • Session \`${manifest.id}\`*`
  );

  return lines.join("\n") + "\n";
}

/**
 * Safely appends summary text to GITHUB_STEP_SUMMARY if available.
 * If targetPath is not provided, defaults to process.env.GITHUB_STEP_SUMMARY.
 * Returns write status without throwing.
 */
export function appendGitHubStepSummary(
  summaryMarkdown: string,
  customSummaryPath?: string
): { readonly written: boolean; readonly targetPath?: string; readonly error?: string } {
  const targetPath = customSummaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  if (!targetPath || targetPath.trim().length === 0) {
    return { written: false };
  }

  try {
    const content = summaryMarkdown.endsWith("\n") ? summaryMarkdown : summaryMarkdown + "\n";
    appendFileSync(targetPath, content, "utf-8");
    return { written: true, targetPath };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { written: false, targetPath, error };
  }
}
