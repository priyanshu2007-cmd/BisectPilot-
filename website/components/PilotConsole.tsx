"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type TurnKind = "prompt" | "tool" | "model" | "result";

export type Turn = {
  id: string;
  time: string;
  latencyMs: number;
  baselineLatencyMs: number;
  label: string;
  kind: TurnKind;
  summary: string;
  baselineOutput: string;
  currentOutput: string;
  detail: string;
  changed: boolean;
  firstDrift?: boolean;
  metric: string;
  commitRef: string;
  sourceSpan: string;
};

export type Scenario = {
  id: string;
  name: string;
  currentRunId: string;
  baselineRunId: string;
  branch: string;
  commit: string;
  model: string;
  firstDriftTurn: string;
  driftScore: string;
  toolCallDelta: string;
  turns: Turn[];
};

export const SCENARIOS: Scenario[] = [
  {
    id: "incident-triage",
    name: "Incident Severity Drift",
    currentRunId: "run_8f2a",
    baselineRunId: "run_7bd1",
    branch: "main",
    commit: "7c3d91a",
    model: "claude-sonnet-4.5",
    firstDriftTurn: "04",
    driftScore: "0.81",
    toolCallDelta: "07 -> 09",
    turns: [
      {
        id: "01",
        time: "09:14:02.184",
        latencyMs: 42,
        baselineLatencyMs: 41,
        label: "system / baseline",
        kind: "prompt",
        summary: "Load incident response policy v12 and severity rubric",
        baselineOutput: "policy_version: v12\nstrict_escalation: true\nrubric: P1_if_customer_facing",
        currentOutput: "policy_version: v12\nstrict_escalation: true\nrubric: P1_if_customer_facing",
        detail: "System prompt loaded from policy v12. Byte-identical SHA-256 digest across both runs.",
        changed: false,
        metric: "stable",
        commitRef: "a41b09e",
        sourceSpan: "prompts/incident_system.md:1-48",
      },
      {
        id: "02",
        time: "09:14:02.310",
        latencyMs: 118,
        baselineLatencyMs: 115,
        label: "user / request",
        kind: "prompt",
        summary: "Summarize attached checkout outage report and assign severity",
        baselineOutput: "attachment: inc_2026_10_19.pdf (1,284 tokens)\nscope: eu-west-1 checkout 502s",
        currentOutput: "attachment: inc_2026_10_19.pdf (1,284 tokens)\nscope: eu-west-1 checkout 502s",
        detail: "Input tokens: 1,284. Attachment resolver returned identical document chunks in both runs.",
        changed: false,
        metric: "1,284 tok",
        commitRef: "a41b09e",
        sourceSpan: "ingest/attachment_resolver.ts:84-112",
      },
      {
        id: "03",
        time: "09:14:02.712",
        latencyMs: 384,
        baselineLatencyMs: 229,
        label: "tool / retrieve",
        kind: "tool",
        summary: "retrieval.search(query='checkout_502_incident', top_k=6)",
        baselineOutput: "top_k: 4\nchunks: [runbook_p1, sla_matrix, gateway_logs, mitigation_steps]",
        currentOutput: "top_k: 6\nchunks: [runbook_p1, sla_matrix, gateway_logs, mitigation_steps, staging_note_low, archive_2024]",
        detail: "Retriever top_k increased from 4 to 6 in commit 7c3d91a, injecting two low-severity staging notes into context.",
        changed: true,
        metric: "+2 chunks",
        commitRef: "7c3d91a",
        sourceSpan: "tools/retrieval.ts:29-47",
      },
      {
        id: "04",
        time: "09:14:03.090",
        latencyMs: 412,
        baselineLatencyMs: 360,
        label: "model / planning",
        kind: "model",
        summary: "Weighing production gateway 502s against staging note context",
        baselineOutput: "temperature: 0.20\nplan: classify as HIGH (P1) due to 14.2% checkout drop",
        currentOutput: "temperature: 0.35\nplan: downgrade to LOW due to staging_note_low chunk weight",
        detail: "First causal divergence: temperature shifted 0.20 -> 0.35 and model anchored on appended staging chunk.",
        changed: true,
        firstDrift: true,
        metric: "temp 0.35",
        commitRef: "7c3d91a",
        sourceSpan: "agent/planner.ts:63-91",
      },
      {
        id: "05",
        time: "09:14:03.441",
        latencyMs: 295,
        baselineLatencyMs: 240,
        label: "tool / extract",
        kind: "tool",
        summary: "document.extract(fields=[severity, owner, next_step, env_hint])",
        baselineOutput: "{ severity: 'HIGH', owner: 'payments-oncall', next_step: 'rollback_gateway_v4' }",
        currentOutput: "{ severity: 'LOW', owner: 'payments-oncall', next_step: 'monitor_next_24h', env_hint: null, override: null }",
        detail: "Extractor received wider schema (+2 nullable fields) and propagated the downgraded severity from Turn 04.",
        changed: true,
        metric: "schema +2",
        commitRef: "7c3d91a",
        sourceSpan: "schemas/incident_extract.json:14-38",
      },
      {
        id: "06",
        time: "09:14:04.006",
        latencyMs: 510,
        baselineLatencyMs: 465,
        label: "model / answer",
        kind: "result",
        summary: "Final classification emitted: LOW severity (expected HIGH / P1)",
        baselineOutput: "verdict: HIGH (P1)\npager_triggered: true\nsummary: Immediate rollback required for eu-west-1.",
        currentOutput: "verdict: LOW (P3)\npager_triggered: false\nsummary: Non-critical staging anomaly; monitor passive metrics.",
        detail: "Terminal semantic drift (0.81 cosine distance). Pager escalation was skipped because Turn 04 downgraded severity.",
        changed: true,
        metric: "drift 0.81",
        commitRef: "7c3d91a",
        sourceSpan: "agent/responder.ts:102-128",
      },
    ],
  },
  {
    id: "sql-schema-drift",
    name: "SQL Tool Filter Regression",
    currentRunId: "run_4c91",
    baselineRunId: "run_4b10",
    branch: "feat/analytics-v2",
    commit: "e91a40c",
    model: "claude-sonnet-4.5",
    firstDriftTurn: "03",
    driftScore: "0.74",
    toolCallDelta: "04 -> 05",
    turns: [
      {
        id: "01",
        time: "11:02:10.012",
        latencyMs: 38,
        baselineLatencyMs: 39,
        label: "system / schema",
        kind: "prompt",
        summary: "Load read-only analytics warehouse dialect rules",
        baselineOutput: "dialect: postgres_16\nexclude_refunded: true\ntimezone: UTC",
        currentOutput: "dialect: postgres_16\nexclude_refunded: true\ntimezone: UTC",
        detail: "Warehouse system prompt unchanged between baseline and feature branch.",
        changed: false,
        metric: "stable",
        commitRef: "88d120f",
        sourceSpan: "prompts/sql_agent.md:1-34",
      },
      {
        id: "02",
        time: "11:02:10.145",
        latencyMs: 94,
        baselineLatencyMs: 92,
        label: "user / query",
        kind: "prompt",
        summary: "Compute net Q3 settled revenue for enterprise tier",
        baselineOutput: "metric: net_settled_revenue\nquarter: 2026-Q3\ntier: enterprise",
        currentOutput: "metric: net_settled_revenue\nquarter: 2026-Q3\ntier: enterprise",
        detail: "User prompt and parsed intent parameters match baseline.",
        changed: false,
        metric: "412 tok",
        commitRef: "88d120f",
        sourceSpan: "agent/intent_parser.ts:19-44",
      },
      {
        id: "03",
        time: "11:02:10.620",
        latencyMs: 310,
        baselineLatencyMs: 280,
        label: "tool / sql_gen",
        kind: "tool",
        summary: "warehouse.generate_sql(table='invoices', filter_status=...)",
        baselineOutput: "SELECT SUM(amount_cents) FROM invoices WHERE tier = 'enterprise' AND status = 'settled'",
        currentOutput: "SELECT SUM(amount_cents) FROM invoices WHERE tier = 'enterprise' AND status IN ('settled', 'pending_refund')",
        detail: "First divergence: tool schema enum expansion in e91a40c included 'pending_refund' in default active statuses.",
        changed: true,
        firstDrift: true,
        metric: "+1 enum",
        commitRef: "e91a40c",
        sourceSpan: "tools/warehouse_sql.ts:52-79",
      },
      {
        id: "04",
        time: "11:02:11.090",
        latencyMs: 490,
        baselineLatencyMs: 310,
        label: "result / answer",
        kind: "result",
        summary: "Reported $1,482,910 instead of $1,319,400 (+12.4% overstatement)",
        baselineOutput: "net_settled_usd: $1,319,400.00\nrows_scanned: 4,128",
        currentOutput: "net_settled_usd: $1,482,910.00\nrows_scanned: 4,619",
        detail: "Output overstated net revenue by $163,510 due to un-excluded pending refunds in Turn 03.",
        changed: true,
        metric: "+12.4% err",
        commitRef: "e91a40c",
        sourceSpan: "agent/reporter.ts:71-95",
      },
    ],
  },
];

const tabCopy = {
  timeline: {
    title: "Turn-by-turn bisection trail",
    description: "Inspect every prompt, tool call, and model decision alongside its known-good baseline.",
  },
  evidence: {
    title: "Root-cause diff & provenance",
    description: "Pinpoint the exact commit, parameter mutation, and CLI replay command for the active turn.",
  },
  notes: {
    title: "Investigation notes & handoff",
    description: "Attach engineering breadcrumbs to specific turns and export a clean markdown summary.",
  },
} as const;

type Tab = keyof typeof tabCopy;
type CompareMode = "diff" | "current" | "baseline";

type NoteItem = {
  turnId: string;
  author: string;
  timestamp: string;
  text: string;
};

export default function PilotConsole({ fullPage = false }: { fullPage?: boolean }) {
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const scenario = useMemo(
    () => SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId]
  );

  const [activeTurnId, setActiveTurnId] = useState<string>("04");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<TurnKind | "all">("all");
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>("diff");
  const [tab, setTab] = useState<Tab>("timeline");
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [notes, setNotes] = useState<NoteItem[]>([
    {
      turnId: "03",
      author: "m.lin",
      timestamp: "14m ago",
      text: "Commit 7c3d91a bumped top_k from 4 to 6 in tools/retrieval.ts; pulled staging_note_low into context.",
    },
    {
      turnId: "04",
      author: "a.patel",
      timestamp: "6m ago",
      text: "Confirmed: pinning top_k=4 and temperature=0.20 restores HIGH (P1) classification on replay.",
    },
  ]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const turns = scenario.turns;

  const visibleTurns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return turns.filter((turn) => {
      const matchesKind = kindFilter === "all" || turn.kind === kindFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [turn.id, turn.label, turn.summary, turn.detail, turn.kind, turn.commitRef, turn.sourceSpan].some((value) =>
          value.toLowerCase().includes(normalizedQuery)
        );
      return matchesKind && matchesQuery && (!showChangedOnly || turn.changed);
    });
  }, [turns, query, kindFilter, showChangedOnly]);

  const selectedTurn = useMemo(() => {
    const inVisible = visibleTurns.find((turn) => turn.id === activeTurnId);
    if (inVisible) return inVisible;
    if (visibleTurns.length > 0) return visibleTurns[0];
    return turns.find((turn) => turn.id === activeTurnId) ?? turns[0];
  }, [visibleTurns, turns, activeTurnId]);

  useEffect(() => {
    if (!isPlaying) return;

    const timer = window.setInterval(() => {
      const currentIdx = turns.findIndex((turn) => turn.id === selectedTurn.id);
      if (currentIdx >= turns.length - 1) {
        setIsPlaying(false);
        return;
      }
      setActiveTurnId(turns[currentIdx + 1].id);
    }, 900);

    return () => window.clearInterval(timer);
  }, [isPlaying, turns, selectedTurn.id]);

  useEffect(() => {
    if (!copiedId) return;
    const timeout = window.setTimeout(() => setCopiedId(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [copiedId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !isInput) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (isInput) return;

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const idx = visibleTurns.findIndex((turn) => turn.id === selectedTurn.id);
        if (idx >= 0 && idx < visibleTurns.length - 1) {
          setActiveTurnId(visibleTurns[idx + 1].id);
        }
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const idx = visibleTurns.findIndex((turn) => turn.id === selectedTurn.id);
        if (idx > 0) {
          setActiveTurnId(visibleTurns[idx - 1].id);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleTurns, selectedTurn.id]);

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(key);
    } catch {
      setCopiedId(null);
    }
  }

  function handleSelectScenario(nextId: string) {
    const nextScenario = SCENARIOS.find((item) => item.id === nextId) ?? SCENARIOS[0];
    setScenarioId(nextScenario.id);
    setActiveTurnId(nextScenario.firstDriftTurn);
    setIsPlaying(false);
  }

  function toggleReplay() {
    const currentIdx = turns.findIndex((turn) => turn.id === selectedTurn.id);
    if (currentIdx >= turns.length - 1) {
      setActiveTurnId(turns[0].id);
    }
    setIsPlaying((playing) => !playing);
  }

  function jumpToFirstDrift() {
    setIsPlaying(false);
    setShowChangedOnly(false);
    setKindFilter("all");
    setQuery("");
    setActiveTurnId(scenario.firstDriftTurn);
  }

  function stepTurn(delta: number) {
    setIsPlaying(false);
    const list = visibleTurns.length > 0 ? visibleTurns : turns;
    const idx = list.findIndex((turn) => turn.id === selectedTurn.id);
    const nextIdx = Math.min(Math.max(idx + delta, 0), list.length - 1);
    setActiveTurnId(list[nextIdx].id);
  }

  function resetFilters() {
    setQuery("");
    setKindFilter("all");
    setShowChangedOnly(false);
  }

  function handleAddNote(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    setNotes((prev) => [
      {
        turnId: selectedTurn.id,
        author: "you",
        timestamp: "just now",
        text: trimmed,
      },
      ...prev,
    ]);
    setNoteDraft("");
  }

  const activeTab = tabCopy[tab];
  const changedCount = turns.filter((turn) => turn.changed).length;
  const replayCliCommand = `bisectpilot bisect ${scenario.baselineRunId}..${scenario.currentRunId} --turn ${selectedTurn.id}`;
  const activeVisibleIndex = visibleTurns.findIndex((turn) => turn.id === selectedTurn.id);

  return (
    <div className={`pilot-console ${fullPage ? "pilot-console-full" : ""}`}>
      {/* Top Toolbar */}
      <div className="console-toolbar">
        <div className="run-identity">
          <span className="status-pip" aria-hidden="true" />
          <label className="scenario-picker-label">
            <span className="sr-only">Select regression specimen</span>
            <select
              className="scenario-select"
              value={scenario.id}
              onChange={(event) => handleSelectScenario(event.target.value)}
              aria-label="Regression scenario"
            >
              {SCENARIOS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.currentRunId} — {item.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="run-id"
            onClick={() => copyText("run-id", scenario.currentRunId)}
            type="button"
            aria-label={`Copy run ID ${scenario.currentRunId}`}
          >
            {scenario.currentRunId}
            <span aria-hidden="true">{copiedId === "run-id" ? "✓" : "⧉"}</span>
          </button>

          <span className="run-branch">
            {scenario.branch} @ {scenario.commit}
          </span>
        </div>

        <div className="console-toolbar-actions">
          <span className="toolbar-note" aria-live="polite">
            {copiedId === "run-id"
              ? "Copied run ID"
              : copiedId === "cli"
                ? "Copied CLI command"
                : `${scenario.baselineRunId} ↔ ${scenario.currentRunId}`}
          </span>

          <div className="step-controls" role="group" aria-label="Turn step controls">
            <button
              className="step-button"
              type="button"
              onClick={() => stepTurn(-1)}
              disabled={activeVisibleIndex <= 0}
              aria-label="Previous turn"
              title="Previous turn (k or Up)"
            >
              ←
            </button>
            <button
              className="step-button"
              type="button"
              onClick={() => stepTurn(1)}
              disabled={activeVisibleIndex === -1 || activeVisibleIndex >= visibleTurns.length - 1}
              aria-label="Next turn"
              title="Next turn (j or Down)"
            >
              →
            </button>
          </div>

          <button
            className="bisect-jump-button"
            type="button"
            onClick={jumpToFirstDrift}
            title="Jump directly to the first causal divergence"
          >
            <span className="drift-indicator" aria-hidden="true">×</span>
            First drift · T{scenario.firstDriftTurn}
          </button>

          <button
            className={`replay-button ${isPlaying ? "is-playing" : ""}`}
            type="button"
            onClick={toggleReplay}
          >
            <span className="replay-icon" aria-hidden="true">
              {isPlaying ? "Ⅱ" : "▶"}
            </span>
            {isPlaying ? "Pause" : "Replay"}
          </button>
        </div>
      </div>

      {/* Main 3-Zone Console Layout */}
      <div className="console-layout">
        {/* Left Sidebar: Run Comparison Mode + Filters + Summary */}
        <aside className="console-sidebar" aria-label="Run controls and filters">
          <div className="sidebar-section">
            <p className="sidebar-label">comparison lens</p>
            <button
              className={`compare-run ${compareMode === "diff" ? "active" : ""}`}
              type="button"
              onClick={() => setCompareMode("diff")}
            >
              <span className="compare-dot dot-diff" aria-hidden="true" />
              <span>
                <strong>side-by-side diff</strong>
                <small>
                  {scenario.baselineRunId} ↔ {scenario.currentRunId}
                </small>
              </span>
              {compareMode === "diff" && (
                <span className="compare-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>

            <button
              className={`compare-run ${compareMode === "current" ? "active" : ""}`}
              type="button"
              onClick={() => setCompareMode("current")}
            >
              <span className="compare-dot dot-current" aria-hidden="true" />
              <span>
                <strong>current (failing)</strong>
                <small>{scenario.currentRunId} · head</small>
              </span>
              {compareMode === "current" && (
                <span className="compare-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>

            <button
              className={`compare-run ${compareMode === "baseline" ? "active" : ""}`}
              type="button"
              onClick={() => setCompareMode("baseline")}
            >
              <span className="compare-dot dot-good" aria-hidden="true" />
              <span>
                <strong>known-good</strong>
                <small>{scenario.baselineRunId} · baseline</small>
              </span>
              {compareMode === "baseline" && (
                <span className="compare-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          </div>

          <div className="sidebar-section sidebar-filters">
            <p className="sidebar-label">filter trail</p>
            <label className="search-field">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <span className="sr-only">Search turns</span>
              <input
                ref={searchInputRef}
                type="search"
                placeholder="Filter turns…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd title="Press / to focus">/</kbd>
            </label>

            <div className="kind-pills" role="group" aria-label="Filter by turn type">
              {(["all", "prompt", "tool", "model", "result"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`kind-pill ${kindFilter === kind ? "active" : ""}`}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind}
                </button>
              ))}
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={showChangedOnly}
                onChange={(event) => setShowChangedOnly(event.target.checked)}
              />
              <span className="fake-toggle" aria-hidden="true" />
              <span>Only diverged turns ({changedCount})</span>
            </label>
          </div>

          <div className="sidebar-section sidebar-summary">
            <p className="sidebar-label">telemetry delta</p>
            <div className="summary-line">
              <span>model</span>
              <strong>{scenario.model}</strong>
            </div>
            <div className="summary-line">
              <span>diverged turns</span>
              <strong>
                {changedCount.toString().padStart(2, "0")} / {turns.length.toString().padStart(2, "0")}
              </strong>
            </div>
            <div className="summary-line">
              <span>tool calls</span>
              <strong>{scenario.toolCallDelta}</strong>
            </div>
            <div className="summary-line">
              <span>first causal drift</span>
              <strong className="orange-text">turn {scenario.firstDriftTurn}</strong>
            </div>
            <div className="summary-line">
              <span>semantic drift</span>
              <strong className="orange-text">{scenario.driftScore}</strong>
            </div>
          </div>
        </aside>

        {/* Right / Main Workspace */}
        <section className="console-main" aria-label="Replay explorer workspace">
          {/* View Mode Tabs */}
          <div className="console-tabs" role="tablist" aria-label="Explorer views">
            {(Object.keys(tabCopy) as Tab[]).map((tabName) => (
              <button
                className={tab === tabName ? "tab-button active" : "tab-button"}
                key={tabName}
                type="button"
                role="tab"
                aria-selected={tab === tabName}
                onClick={() => setTab(tabName)}
              >
                {tabName}
                {tabName === "notes" && (
                  <span className="tab-badge">{notes.length}</span>
                )}
              </button>
            ))}
            <span className="tab-spacer" />
            <span className="live-readout" aria-live="polite">
              j / k to step · / to filter
            </span>
          </div>

          <div className="timeline-heading">
            <div>
              <h3>{activeTab.title}</h3>
              <p>{activeTab.description}</p>
            </div>
            <span className="timeline-count">
              showing {visibleTurns.length.toString().padStart(2, "0")} of{" "}
              {turns.length.toString().padStart(2, "0")} turns
            </span>
          </div>

          {/* Split Workspace: Turn Trail List + Live Inspector Pane */}
          <div className="explorer-split">
            {/* Column 1: Turn List */}
            <div className="turn-list" role="list" aria-label="Execution turns">
              {visibleTurns.length > 0 ? (
                visibleTurns.map((turn) => {
                  const isActive = selectedTurn.id === turn.id;
                  return (
                    <button
                      className={`turn-row ${isActive ? "active" : ""} ${
                        turn.changed ? "changed" : ""
                      } ${turn.firstDrift ? "first-drift-row" : ""}`}
                      key={turn.id}
                      type="button"
                      onClick={() => setActiveTurnId(turn.id)}
                      role="listitem"
                      aria-label={`Turn ${turn.id}, ${turn.label}`}
                    >
                      <span className="turn-index">{turn.id}</span>
                      <span
                        className={`turn-kind kind-${turn.kind}`}
                        aria-hidden="true"
                      >
                        {turn.kind.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="turn-copy">
                        <span className="turn-meta">
                          <strong>{turn.label}</strong>
                          <time>{turn.time}</time>
                          {turn.firstDrift && (
                            <span className="first-drift-pill">first drift</span>
                          )}
                        </span>
                        <span className="turn-summary">{turn.summary}</span>
                      </span>
                      <span className="turn-metric">{turn.metric}</span>
                      <span
                        className="change-mark"
                        aria-label={
                          turn.changed ? "Changed between runs" : "Unchanged"
                        }
                      >
                        {turn.changed ? "×" : "·"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="empty-state" role="status">
                  <strong>No turns match active filters.</strong>
                  <span>
                    Query &ldquo;{query || kindFilter}&rdquo; hidden all{" "}
                    {turns.length} turns in this specimen.
                  </span>
                  <button
                    className="reset-filter-button"
                    type="button"
                    onClick={resetFilters}
                  >
                    Reset filters ↻
                  </button>
                </div>
              )}
            </div>

            {/* Column 2: Active Turn Inspector (Adapts to Timeline / Evidence / Notes tab) */}
            <div className="turn-inspector" aria-live="polite">
              <div className="detail-rule" aria-hidden="true" />

              <div className="detail-heading">
                <span
                  className={`turn-kind kind-${selectedTurn.kind}`}
                  aria-hidden="true"
                >
                  {selectedTurn.kind.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <span className="detail-kicker">
                    turn {selectedTurn.id} · {selectedTurn.kind} ·{" "}
                    {selectedTurn.changed ? "diverged from baseline" : "baseline match"}
                  </span>
                  <h4>{selectedTurn.label}</h4>
                </div>
                <span className={`detail-metric ${selectedTurn.changed ? "is-changed" : ""}`}>
                  {selectedTurn.metric}
                </span>
              </div>

              <p className="inspector-explanation">{selectedTurn.detail}</p>

              {tab === "timeline" && (
                <div className="diff-panes">
                  {(compareMode === "diff" || compareMode === "baseline") && (
                    <div className="diff-pane pane-baseline">
                      <div className="pane-header">
                        <span className="pane-badge badge-good">
                          known-good · {scenario.baselineRunId}
                        </span>
                        <span className="pane-latency">
                          {selectedTurn.baselineLatencyMs}ms
                        </span>
                      </div>
                      <pre className="pane-code">
                        <code>{selectedTurn.baselineOutput}</code>
                      </pre>
                    </div>
                  )}

                  {(compareMode === "diff" || compareMode === "current") && (
                    <div
                      className={`diff-pane ${
                        selectedTurn.changed ? "pane-diverged" : "pane-current"
                      }`}
                    >
                      <div className="pane-header">
                        <span
                          className={`pane-badge ${
                            selectedTurn.changed ? "badge-current" : "badge-good"
                          }`}
                        >
                          current · {scenario.currentRunId}
                        </span>
                        <span className="pane-latency">
                          {selectedTurn.latencyMs}ms (
                          {selectedTurn.latencyMs >= selectedTurn.baselineLatencyMs
                            ? `+${selectedTurn.latencyMs - selectedTurn.baselineLatencyMs}ms`
                            : `${selectedTurn.latencyMs - selectedTurn.baselineLatencyMs}ms`}
                          )
                        </span>
                      </div>
                      <pre className="pane-code">
                        <code>{selectedTurn.currentOutput}</code>
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {tab === "evidence" && (
                <div className="evidence-panel">
                  <div className="evidence-grid">
                    <div className="evidence-cell">
                      <span>suspect commit</span>
                      <strong>{selectedTurn.commitRef}</strong>
                    </div>
                    <div className="evidence-cell">
                      <span>source location</span>
                      <strong>{selectedTurn.sourceSpan}</strong>
                    </div>
                    <div className="evidence-cell">
                      <span>latency delta</span>
                      <strong>
                        {selectedTurn.baselineLatencyMs}ms → {selectedTurn.latencyMs}ms
                      </strong>
                    </div>
                    <div className="evidence-cell">
                      <span>causal status</span>
                      <strong className={selectedTurn.changed ? "orange-text" : ""}>
                        {selectedTurn.firstDrift
                          ? "Root divergence (Turn " + selectedTurn.id + ")"
                          : selectedTurn.changed
                            ? "Downstream propagation"
                            : "Verified invariant"}
                      </strong>
                    </div>
                  </div>

                  <div className="cli-repro-box">
                    <div className="cli-repro-head">
                      <span>reproduce turn locally</span>
                      <button
                        type="button"
                        className="copy-cli-btn"
                        onClick={() => copyText("cli", replayCliCommand)}
                      >
                        {copiedId === "cli" ? "Copied ✓" : "Copy command ⧉"}
                      </button>
                    </div>
                    <pre className="pane-code">
                      <code>{replayCliCommand}</code>
                    </pre>
                  </div>
                </div>
              )}

              {tab === "notes" && (
                <div className="notes-panel">
                  <form className="note-form" onSubmit={handleAddNote}>
                    <label htmlFor="turn-note-input" className="note-form-label">
                      Add engineering note to Turn {selectedTurn.id}
                    </label>
                    <div className="note-input-row">
                      <input
                        id="turn-note-input"
                        type="text"
                        placeholder={`Record hypothesis for Turn ${selectedTurn.id}…`}
                        value={noteDraft}
                        onChange={(event) => setNoteDraft(event.target.value)}
                      />
                      <button type="submit" className="note-submit-btn">
                        Attach
                      </button>
                    </div>
                  </form>

                  <div className="notes-list">
                    {notes.map((note, index) => (
                      <div
                        key={`${note.turnId}-${index}`}
                        className={`note-card ${
                          note.turnId === selectedTurn.id ? "note-card-active" : ""
                        }`}
                      >
                        <div className="note-card-meta">
                          <button
                            type="button"
                            className="note-turn-chip"
                            onClick={() => setActiveTurnId(note.turnId)}
                          >
                            Turn {note.turnId}
                          </button>
                          <span>@{note.author}</span>
                          <span>{note.timestamp}</span>
                        </div>
                        <p>{note.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="detail-footer">
                <span>
                  <span className="mini-dot" aria-hidden="true" />
                  {selectedTurn.sourceSpan}
                </span>
                <span>
                  commit {selectedTurn.commitRef} · Δ vs {scenario.baselineRunId}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
