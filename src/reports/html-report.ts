import type { LedgerEvent, SessionManifestV1 } from "../contracts/index.js";
import { verifyLedgerChain } from "../ledger/index.js";
import { collapseConsecutiveEvaluations, generateJsonReport, redactSensitiveText } from "./index.js";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generates a self-contained, offline interactive HTML report from session data.
 * Zero external network dependencies (no CDNs, remote scripts, or Google Fonts).
 * Fully safe against stored/reflected XSS through escaping and safe JSON serialization.
 */
export function generateHtmlReport(
  manifest: SessionManifestV1,
  events: readonly LedgerEvent[]
): string {
  const jsonReport = generateJsonReport(manifest, events);
  const ledgerCheck = verifyLedgerChain(events);

  const badTerm = manifest.config.terms?.new ? `First ${manifest.config.terms.new}` : "First Bad";
  const goodTerm = manifest.config.terms?.old
    ? manifest.config.terms.old.charAt(0).toUpperCase() + manifest.config.terms.old.slice(1)
    : "Last Good";

  const boundaryEvents = events.filter(
    (e): e is Extract<LedgerEvent, { type: "boundary_check" }> => e.type === "boundary_check"
  );

  // Safe JSON payload for client-side interactivity
  const clientPayload = {
    sessionId: manifest.id,
    outcome: jsonReport.outcome,
    state: jsonReport.state,
    bounds: jsonReport.bounds,
    terms: jsonReport.terms,
    candidateSha: jsonReport.candidateSha,
    parentSha: jsonReport.parentSha,
    candidateRangeShas: jsonReport.candidateRangeShas,
    skippedShas: jsonReport.skippedShas,
    explanation: jsonReport.explanation,
    evaluations: jsonReport.evaluations,
    ledgerValid: ledgerCheck.valid,
    eventCount: events.length,
    ledgerEvents: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      timestamp: e.timestamp,
      eventHash: e.eventHash.slice(0, 12),
      prevHash: e.prevHash.slice(0, 12),
    })),
    oracleCommand: `${manifest.config.oracle.command.command} ${manifest.config.oracle.command.args.join(" ")}`,
  };

  const safeJsonData = JSON.stringify(clientPayload).replace(/</g, "\\u003c");

  const outcomeClass =
    jsonReport.outcome === "candidate_confirmed" || jsonReport.outcome === "candidate_found"
      ? "badge-candidate"
      : jsonReport.outcome === "inconclusive"
      ? "badge-inconclusive"
      : jsonReport.outcome.includes("failed")
      ? "badge-bad"
      : "badge-good";

  const collapsed = collapseConsecutiveEvaluations(jsonReport.evaluations);
  // Pre-rendered evaluations table rows
  const evaluationRows = collapsed.map((ev, index) => {
    const cls = ev.primaryClassification.toLowerCase();
    const badgeCls =
      cls === "good" ? "badge-good" : cls === "bad" ? "badge-bad" : cls === "skip" ? "badge-skip" : "badge-inconclusive";
    const manualBadge =
      ev.classifiedBy === "human"
        ? '<span class="badge badge-manual">manual</span>'
        : "";
    const noisyBadge = ev.noisySampling
      ? `<span class="badge badge-noisy" title="P(bad)=${ev.noisySampling.posterior.toFixed(
          2
        )}, ${ev.noisySampling.failedRuns}F/${ev.noisySampling.passedRuns}P">noisy (${ev.noisySampling.sampleCount} runs)</span>`
      : "";

    const shortSha = escapeHtml(ev.commitSha.slice(0, 8));
    const fullSha = escapeHtml(ev.commitSha);
    const classification = escapeHtml(ev.classificationSummary);
    const reasonCode = escapeHtml(ev.reasonCode);
    const detail = escapeHtml(ev.detail || "-");

    return `
      <tr class="eval-row" data-cls="${cls}" data-sha="${fullSha.toLowerCase()}" data-manual="${ev.classifiedBy === "human" ? "true" : "false"}">
        <td class="col-seq">#${index + 1}</td>
        <td class="col-sha">
          <code class="commit-sha" title="${fullSha}">${shortSha}</code>
          <button class="btn-copy-small" data-copy="${fullSha}" title="Copy Commit SHA">📋</button>
        </td>
        <td class="col-status">
          <span class="badge ${badgeCls}">${classification}</span>
          ${manualBadge}
          ${noisyBadge}
        </td>
        <td class="col-reason"><code>${reasonCode}</code></td>
        <td class="col-detail">${detail}</td>
      </tr>
    `;
  }).join("\n");

  const ledgerBadge = ledgerCheck.valid
    ? `<span class="badge badge-good">✅ Verified (${events.length} events)</span>`
    : `<span class="badge badge-bad">⚠️ Broken at #${ledgerCheck.brokenAtSeq}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BisectPilot Report — ${escapeHtml(manifest.id)}</title>
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #111827;
      --surface-elevated: #1f2937;
      --border: #374151;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --good: #10b981;
      --good-bg: rgba(16, 185, 129, 0.15);
      --bad: #ef4444;
      --bad-bg: rgba(239, 68, 68, 0.15);
      --skip: #f59e0b;
      --skip-bg: rgba(245, 158, 11, 0.15);
      --candidate: #8b5cf6;
      --candidate-bg: rgba(139, 92, 246, 0.15);
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.5;
      padding: 2rem 1rem;
      min-height: 100vh;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-icon {
      font-size: 1.75rem;
      background: var(--surface-elevated);
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    h1 { font-size: 1.5rem; font-weight: 700; }
    .session-subtitle { color: var(--text-muted); font-size: 0.875rem; font-family: var(--font-mono); }
    .header-actions { display: flex; gap: 0.5rem; align-items: center; }
    button {
      background: var(--surface-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.875rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover { background: #374151; border-color: #4b5563; }
    .btn-copy-small {
      padding: 0.15rem 0.35rem;
      font-size: 0.75rem;
      border-radius: 4px;
      margin-left: 0.25rem;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-good { background: var(--good-bg); color: var(--good); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-bad { background: var(--bad-bg); color: var(--bad); border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-skip { background: var(--skip-bg); color: var(--skip); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-candidate { background: var(--candidate-bg); color: var(--candidate); border: 1px solid rgba(139, 92, 246, 0.3); }
    .badge-inconclusive { background: rgba(156, 163, 175, 0.15); color: #d1d5db; border: 1px solid rgba(156, 163, 175, 0.3); }
    .badge-manual { background: rgba(59, 130, 246, 0.15); color: var(--primary); border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-noisy { background: rgba(245, 158, 11, 0.1); color: #fbbf24; border: 1px dashed rgba(245, 158, 11, 0.4); text-transform: none; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
    }
    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }
    .metric-tile {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
    }
    .metric-label { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .metric-value { font-size: 1.15rem; font-weight: 700; margin-top: 0.25rem; word-break: break-all; }
    .metric-sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
    code {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: rgba(255, 255, 255, 0.06);
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
    }
    .explanation-box {
      margin-top: 1rem;
      padding: 0.85rem;
      background: rgba(59, 130, 246, 0.08);
      border-left: 4px solid var(--primary);
      border-radius: 4px;
      font-size: 0.95rem;
    }
    .filter-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 1rem;
      align-items: center;
    }
    .filter-chips { display: flex; gap: 0.35rem; flex-wrap: wrap; }
    .chip {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.3rem 0.65rem;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .chip.active, .chip:hover {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .search-input {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
      min-width: 240px;
    }
    .search-input:focus { border-color: var(--primary); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.65rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--text-muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.02);
    }
    tr.eval-row:hover { background: rgba(255, 255, 255, 0.03); }
    .col-seq { width: 50px; color: var(--text-muted); font-family: var(--font-mono); }
    .col-sha { width: 140px; }
    .col-status { width: 180px; }
    .col-reason { width: 140px; }
    .col-detail { color: var(--text); }
    pre {
      background: #050811;
      padding: 0.85rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 0.825rem;
      color: #e5e7eb;
    }
    .details-toggle {
      color: var(--primary);
      cursor: pointer;
      font-size: 0.85rem;
      user-select: none;
    }
    .details-toggle:hover { text-decoration: underline; }
    .collapsible-body { display: none; margin-top: 0.75rem; }
    .collapsible-body.open { display: block; }
    .toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      background: #10b981;
      color: #fff;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }
    .toast.show { opacity: 1; }
    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">🎯</div>
        <div>
          <h1>BisectPilot Investigation Report</h1>
          <div class="session-subtitle">Session: ${escapeHtml(manifest.id)}</div>
        </div>
      </div>
      <div class="header-actions">
        <span class="badge ${outcomeClass}">${escapeHtml(jsonReport.outcome)}</span>
        <button id="btn-copy-session" data-copy="${escapeHtml(manifest.id)}">📋 Copy Session ID</button>
      </div>
    </header>

    <!-- Executive Overview Card -->
    <div class="card">
      <div class="card-title">Executive Summary</div>
      <div class="metrics-grid">
        <div class="metric-tile">
          <div class="metric-label">Investigation Outcome</div>
          <div class="metric-value"><span class="badge ${outcomeClass}">${escapeHtml(jsonReport.outcome)}</span></div>
          <div class="metric-sub">State: <code>${escapeHtml(jsonReport.state)}</code></div>
        </div>
        <div class="metric-tile">
          <div class="metric-label">${escapeHtml(badTerm)} Commit</div>
          <div class="metric-value">
            ${
              jsonReport.candidateSha
                ? `<code>${escapeHtml(jsonReport.candidateSha.slice(0, 8))}</code> <button class="btn-copy-small" data-copy="${escapeHtml(jsonReport.candidateSha)}" title="Copy SHA">📋</button>`
                : '<span style="color:var(--text-muted)">None Identified</span>'
            }
          </div>
          <div class="metric-sub">
            ${
              jsonReport.candidateSha
                ? "First failure-inducing regression"
                : "Search concluded without single commit"
            }
          </div>
        </div>
        <div class="metric-tile">
          <div class="metric-label">${escapeHtml(goodTerm)} Parent</div>
          <div class="metric-value">
            ${
              jsonReport.parentSha
                ? `<code>${escapeHtml(jsonReport.parentSha.slice(0, 8))}</code> <button class="btn-copy-small" data-copy="${escapeHtml(jsonReport.parentSha)}" title="Copy SHA">📋</button>`
                : '<span style="color:var(--text-muted)">N/A</span>'
            }
          </div>
          <div class="metric-sub">Verified passing baseline parent</div>
        </div>
        <div class="metric-tile">
          <div class="metric-label">Ledger Integrity</div>
          <div class="metric-value">${ledgerBadge}</div>
          <div class="metric-sub">Hash-chained cryptographic audit</div>
        </div>
        ${
          jsonReport.finalChainHash
            ? `
        <div class="metric-tile">
          <div class="metric-label">Final Chain Hash</div>
          <div class="metric-value"><code style="font-size:0.75rem">${escapeHtml(jsonReport.finalChainHash.slice(0, 12))}...</code> <button class="btn-copy-small" data-copy="${escapeHtml(jsonReport.finalChainHash)}" title="Copy Full Hash">📋</button></div>
          <div class="metric-sub">External tamper anchor</div>
        </div>`
            : ""
        }
        ${
          jsonReport.benchmark
            ? `
        <div class="metric-tile">
          <div class="metric-label">Benchmark (${escapeHtml(jsonReport.benchmark.metric)})</div>
          <div class="metric-value" style="color:var(--danger)">
            ${jsonReport.benchmark.relativeDelta !== undefined ? `${jsonReport.benchmark.relativeDelta >= 0 ? "+" : ""}${(jsonReport.benchmark.relativeDelta * 100).toFixed(1)}%` : "Regression"}
          </div>
          <div class="metric-sub">
            ${jsonReport.benchmark.baseline ? `Base: ${jsonReport.benchmark.baseline.mean.toFixed(1)}` : ""}
            ${jsonReport.benchmark.candidate ? ` &rarr; Cand: ${jsonReport.benchmark.candidate.mean.toFixed(1)}` : ""}
          </div>
        </div>`
            : ""
        }
      </div>


      <div class="explanation-box">
        <strong>Summary:</strong> ${escapeHtml(jsonReport.explanation)}
      </div>

      <div style="margin-top: 1rem; font-size: 0.85rem; color: var(--text-muted);">
        <span><strong>Good Endpoint:</strong> <code>${escapeHtml(manifest.bounds.goodSha.slice(0, 8))}</code> (${escapeHtml(manifest.bounds.goodInputRef)})</span> &nbsp;|&nbsp;
        <span><strong>Bad Endpoint:</strong> <code>${escapeHtml(manifest.bounds.badSha.slice(0, 8))}</code> (${escapeHtml(manifest.bounds.badInputRef)})</span>
        ${
          manifest.config.terms
            ? ` &nbsp;|&nbsp; <span><strong>Bisect Terms:</strong> Old=<code>${escapeHtml(manifest.config.terms.old)}</code>, New=<code>${escapeHtml(manifest.config.terms.new)}</code></span>`
            : ""
        }
      </div>
    </div>

    ${
      boundaryEvents.length > 0
        ? `
    <!-- Boundary Verification Card -->
    <div class="card">
      <div class="card-title">Candidate Boundary Verification</div>
      <p style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        Confirmation runs performed at endpoints and candidate boundary to ensure stability:
      </p>
      <table>
        <thead>
          <tr>
            <th>Target</th>
            <th>Commit SHA</th>
            <th>Runs</th>
            <th>Passed</th>
            <th>Failed</th>
            <th>Skipped</th>
          </tr>
        </thead>
        <tbody>
          ${boundaryEvents
            .map(
              (b) => `
            <tr>
              <td><code>${escapeHtml(b.target)}</code></td>
              <td><code>${escapeHtml(b.commitSha.slice(0, 8))}</code></td>
              <td>${b.totalRuns}</td>
              <td style="color:var(--good)">${b.passedRuns}</td>
              <td style="color:var(--bad)">${b.failedRuns}</td>
              <td>${b.skippedRuns}</td>
            </tr>
          `
            )
            .join("\n")}
        </tbody>
      </table>
    </div>
    `
        : ""
    }

    <!-- Timeline & Evaluated Revisions -->
    <div class="card">
      <div class="card-title">
        <span>Evaluated Revisions Timeline (${collapsed.length})</span>
      </div>

      <div class="filter-toolbar">
        <div class="filter-chips">
          <button class="chip active" data-filter="all">All (${collapsed.length})</button>
          <button class="chip" data-filter="bad">Bad (${collapsed.filter((e) => e.primaryClassification.toLowerCase() === "bad").length})</button>
          <button class="chip" data-filter="good">Good (${collapsed.filter((e) => e.primaryClassification.toLowerCase() === "good").length})</button>
          <button class="chip" data-filter="skip">Skip (${collapsed.filter((e) => e.primaryClassification.toLowerCase() === "skip").length})</button>
          <button class="chip" data-filter="manual">Manual (${collapsed.filter((e) => e.classifiedBy === "human").length})</button>
        </div>
        <input type="text" id="eval-search" class="search-input" placeholder="Search by SHA, status, reason...">
      </div>

      <div style="overflow-x: auto;">
        <table id="eval-table">
          <thead>
            <tr>
              <th class="col-seq">#</th>
              <th class="col-sha">Commit</th>
              <th class="col-status">Classification</th>
              <th class="col-reason">Reason Code</th>
              <th class="col-detail">Execution Details</th>
            </tr>
          </thead>
          <tbody>
            ${evaluationRows.length > 0 ? evaluationRows : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No evaluations recorded.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Reproduction & Artifacts -->
    <div class="card">
      <div class="card-title">Replay & Artifacts</div>
      <p style="font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        BisectPilot generates an isolated reproducibility script to verify the candidate and parent without touching current working files:
      </p>
      <pre><code># Run the self-contained reproduction script:
bash .bisectpilot/sessions/${escapeHtml(manifest.id)}/repro.sh</code></pre>
      <div style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted);">
        Related Session Artifacts:
        <code>report.json</code> &bull;
        <code>report.md</code> &bull;
        <code>repro.sh</code>
        ${manifest.bounds ? "&bull; <code>bisect.log</code>" : ""}
      </div>
    </div>

    <!-- Ledger Audit Trail Collapsible -->
    <div class="card">
      <div class="card-title">
        <span>Hash-Chained Evidence Ledger</span>
        <span class="details-toggle" id="toggle-ledger">Show Raw Events (${events.length}) ▾</span>
      </div>
      <div id="ledger-body" class="collapsible-body">
        <p style="font-size: 0.825rem; color: var(--text-muted); margin-bottom: 0.5rem;">
          Each event cryptographically references the SHA-256 hash of the preceding event, preventing tampering or silent truncation.
        </p>
        <pre><code id="ledger-stream">${escapeHtml(
          events
            .map(
              (e) =>
                `#${e.seq} [${e.timestamp}] ${e.type} (hash: ${e.eventHash.slice(0, 12)}..., prev: ${e.prevHash.slice(0, 12)}...)`
            )
            .join("\n")
        )}</code></pre>
      </div>
    </div>

    <!-- Environment & Limitations -->
    <div class="card">
      <div class="card-title">Deterministic Environment & Limitations</div>
      <p style="font-size: 0.85rem; margin-bottom: 0.5rem;"><strong>Oracle Command:</strong> <code>${escapeHtml(manifest.config.oracle.command.command)} ${escapeHtml(manifest.config.oracle.command.args.join(" "))}</code></p>
      ${manifest.config.workingDirectory && manifest.config.workingDirectory !== "." ? `<p style="font-size: 0.85rem; margin-bottom: 0.5rem;"><strong>Workspace Directory:</strong> <code>${escapeHtml(manifest.config.workingDirectory)}</code></p>` : ""}
      ${manifest.config.pathScope ? `<p style="font-size: 0.85rem; margin-bottom: 0.5rem;"><strong>Path Scope:</strong> ${manifest.config.pathScope.map((p) => `<code>${escapeHtml(p)}</code>`).join(", ")}</p>` : ""}
      <ul style="font-size: 0.85rem; color: var(--text-muted); padding-left: 1.25rem;">
        ${jsonReport.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join("\n")}
      </ul>
    </div>

    <footer>
      BisectPilot v${escapeHtml(manifest.runnerVersion)} &bull; Deterministic Regression Bisection &bull; Completely Offline Report
    </footer>
  </div>

  <div id="toast" class="toast">Copied to clipboard!</div>

  <script>
    (function() {
      // Safely embedded canonical report data
      var DATA = ${safeJsonData};

      // Toast feedback
      var toast = document.getElementById("toast");
      function showToast(text) {
        if (!toast) return;
        toast.textContent = text || "Copied to clipboard!";
        toast.classList.add("show");
        setTimeout(function() { toast.classList.remove("show"); }, 2000);
      }

      // Copy helpers
      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            showToast("Copied: " + text.slice(0, 12) + (text.length > 12 ? "..." : ""));
          }).catch(function() {
            fallbackCopy(text);
          });
        } else {
          fallbackCopy(text);
        }
      }

      function fallbackCopy(text) {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand("copy");
          showToast("Copied!");
        } catch (e) {
          showToast("Copy failed");
        }
        document.body.removeChild(ta);
      }

      // Wire up copy buttons
      document.querySelectorAll("[data-copy]").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var val = btn.getAttribute("data-copy");
          if (val) copyText(val);
        });
      });

      // Filter chips and search logic
      var currentFilter = "all";
      var searchInput = document.getElementById("eval-search");
      var table = document.getElementById("eval-table");
      var rows = table ? table.querySelectorAll("tbody tr.eval-row") : [];

      function applyFilters() {
        var query = (searchInput ? searchInput.value : "").trim().toLowerCase();
        rows.forEach(function(row) {
          var cls = row.getAttribute("data-cls");
          var sha = row.getAttribute("data-sha");
          var manual = row.getAttribute("data-manual");
          var text = row.textContent.toLowerCase();

          var matchesFilter = true;
          if (currentFilter === "all") {
            matchesFilter = true;
          } else if (currentFilter === "manual") {
            matchesFilter = (manual === "true");
          } else {
            matchesFilter = (cls === currentFilter);
          }

          var matchesSearch = !query || text.indexOf(query) !== -1;
          if (matchesFilter && matchesSearch) {
            row.style.display = "";
          } else {
            row.style.display = "none";
          }
        });
      }

      document.querySelectorAll(".chip").forEach(function(chip) {
        chip.addEventListener("click", function() {
          document.querySelectorAll(".chip").forEach(function(c) { c.classList.remove("active"); });
          chip.classList.add("active");
          currentFilter = chip.getAttribute("data-filter") || "all";
          applyFilters();
        });
      });

      if (searchInput) {
        searchInput.addEventListener("input", applyFilters);
      }

      // Ledger collapsible toggle
      var toggleLedger = document.getElementById("toggle-ledger");
      var ledgerBody = document.getElementById("ledger-body");
      if (toggleLedger && ledgerBody) {
        toggleLedger.addEventListener("click", function() {
          var isOpen = ledgerBody.classList.contains("open");
          if (isOpen) {
            ledgerBody.classList.remove("open");
            toggleLedger.textContent = "Show Raw Events (" + DATA.eventCount + ") ▾";
          } else {
            ledgerBody.classList.add("open");
            toggleLedger.textContent = "Hide Raw Events ▴";
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}
