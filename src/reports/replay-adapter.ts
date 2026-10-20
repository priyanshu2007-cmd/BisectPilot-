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

export interface CliReportJson {
  readonly schemaVersion?: number;
  readonly sessionId: string;
  readonly outcome: string;
  readonly state: string;
  readonly bounds?: {
    readonly goodInputRef?: string;
    readonly goodSha?: string;
    readonly badInputRef?: string;
    readonly badSha?: string;
  };
  readonly candidateSha?: string;
  readonly parentSha?: string;
  readonly candidateRangeShas?: readonly string[];
  readonly skippedShas?: readonly string[];
  readonly explanation?: string;
  readonly evaluations?: ReadonlyArray<{
    readonly commitSha: string;
    readonly classification: string;
    readonly reasonCode: string;
    readonly detail?: string;
    readonly gitExitCode: number;
  }>;
  readonly limitations?: readonly string[];
}

export function isValidScenario(value: unknown): value is Scenario {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.firstDriftTurn === "string" &&
    Array.isArray(candidate.turns) &&
    candidate.turns.length > 0 &&
    candidate.turns.every(
      (turn) =>
        turn &&
        typeof turn === "object" &&
        typeof (turn as Record<string, unknown>).id === "string" &&
        typeof (turn as Record<string, unknown>).baselineOutput === "string" &&
        typeof (turn as Record<string, unknown>).currentOutput === "string"
    )
  );
}

export function isCliReportJson(value: unknown): value is CliReportJson {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sessionId === "string" &&
    typeof c.outcome === "string" &&
    typeof c.state === "string" &&
    (c.evaluations === undefined || Array.isArray(c.evaluations))
  );
}

export function convertReportJsonToScenario(report: CliReportJson): Scenario {
  const evaluations = report.evaluations ?? [];
  const candidateSha = report.candidateSha ? report.candidateSha.toLowerCase() : undefined;
  const turns: Turn[] = [];

  evaluations.forEach((ev, i) => {
    const stepId = (i + 1).toString().padStart(2, "0");
    const commitSha = ev.commitSha ? ev.commitSha.toLowerCase() : "unknown";
    const isCandidate = Boolean(candidateSha && commitSha === candidateSha);
    const isBad = ev.classification === "bad" || isCandidate;
    const kind: TurnKind = ev.classification === "good" ? "tool" : isBad ? "result" : "prompt";

    turns.push({
      id: stepId,
      time: `00:00:${stepId}`,
      latencyMs: 120,
      baselineLatencyMs: 120,
      label: `eval ${stepId} / ${commitSha.slice(0, 8)}`,
      kind,
      summary: `${commitSha.slice(0, 8)}: ${ev.classification.toUpperCase()} (${ev.reasonCode})`,
      baselineOutput: "baseline: good (clean revision)",
      currentOutput: `classification: ${ev.classification}\nexitCode: ${ev.gitExitCode}${ev.detail ? `\n${ev.detail}` : ""}`,
      detail: ev.detail || `Commit ${commitSha} classified as ${ev.classification} (${ev.reasonCode})`,
      changed: isBad,
      firstDrift: isCandidate,
      metric: ev.classification,
      commitRef: commitSha.slice(0, 7),
      sourceSpan: `git:${commitSha.slice(0, 8)}`,
    });
  });

  // Always append a conclusive result turn summarizing the final outcome
  const conclusionStepId = (turns.length + 1).toString().padStart(2, "0");
  const conclusionSha = report.candidateSha || report.bounds?.badSha || "unknown";
  turns.push({
    id: conclusionStepId,
    time: `00:00:${conclusionStepId}`,
    latencyMs: 80,
    baselineLatencyMs: 80,
    label: `conclusion / ${report.outcome}`,
    kind: "result",
    summary: `Outcome: ${report.outcome}`,
    baselineOutput: "session goal: identify exact first bad regression commit",
    currentOutput: `outcome: ${report.outcome}\nexplanation: ${report.explanation || "Session concluded."}`,
    detail: report.explanation || `Session completed with outcome ${report.outcome}`,
    changed: report.outcome === "candidate_confirmed",
    metric: report.outcome,
    commitRef: conclusionSha.slice(0, 7),
    sourceSpan: `session:${report.sessionId}`,
  });

  // Determine first drift turn
  let firstDriftTurn = turns[0]?.id ?? "01";
  const candidateIndex = turns.findIndex((t) => t.firstDrift);
  if (candidateIndex >= 0 && turns[candidateIndex]) {
    firstDriftTurn = turns[candidateIndex]!.id;
  } else {
    const badIndex = turns.findIndex((t) => t.changed);
    if (badIndex >= 0 && turns[badIndex]) {
      firstDriftTurn = turns[badIndex]!.id;
    }
  }

  const shortCommit = report.candidateSha
    ? report.candidateSha.slice(0, 7)
    : report.bounds?.badSha
      ? report.bounds.badSha.slice(0, 7)
      : "unknown";

  const baselineRef = report.bounds?.goodSha
    ? report.bounds.goodSha.slice(0, 8)
    : report.bounds?.goodInputRef || "baseline";

  return {
    id: report.sessionId,
    name: `CLI Report — ${report.sessionId}`,
    currentRunId: report.sessionId,
    baselineRunId: baselineRef,
    branch: report.bounds?.badInputRef || "HEAD",
    commit: shortCommit,
    model: report.outcome,
    firstDriftTurn,
    driftScore: report.candidateSha ? "1.00" : "0.00",
    toolCallDelta: `${evaluations.length} evals (${report.skippedShas?.length ?? 0} skips)`,
    turns,
  };
}

export type ParseImportResult =
  | { readonly ok: true; readonly scenario: Scenario; readonly sourceFormat: "scenario" | "cli_report" }
  | { readonly ok: false; readonly error: string };

export function normalizeImportedJson(parsed: unknown): ParseImportResult {
  if (isValidScenario(parsed)) {
    return { ok: true, scenario: parsed, sourceFormat: "scenario" };
  }
  if (isCliReportJson(parsed)) {
    try {
      const scenario = convertReportJsonToScenario(parsed);
      return { ok: true, scenario, sourceFormat: "cli_report" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to convert CLI report: ${msg}` };
    }
  }
  return {
    ok: false,
    error: "Import rejected: unsupported JSON format (expected Scenario or BisectPilot CLI report)",
  };
}
