import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  convertReportJsonToScenario,
  isCliReportJson,
  isValidScenario,
  normalizeImportedJson,
  type CliReportJson,
  type Scenario,
} from "../../src/reports/index.js";

describe("Feature B — Report Replay Adapter & Schema Normalization", () => {
  const sampleScenario: Scenario = {
    id: "incident-triage",
    name: "Incident Severity Drift",
    currentRunId: "run_8f2a",
    baselineRunId: "run_7bd1",
    branch: "main",
    commit: "7c3d91a",
    model: "claude-sonnet-4.5",
    firstDriftTurn: "02",
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
        summary: "Load incident policy",
        baselineOutput: "policy v12",
        currentOutput: "policy v12",
        detail: "Identical digest across both runs",
        changed: false,
        metric: "stable",
        commitRef: "a41b09e",
        sourceSpan: "prompts/policy.md:1-20",
      },
      {
        id: "02",
        time: "09:14:02.310",
        latencyMs: 118,
        baselineLatencyMs: 115,
        label: "tool / eval",
        kind: "result",
        summary: "Drift detected at checkout",
        baselineOutput: "status: 200",
        currentOutput: "status: 502",
        detail: "502 Bad Gateway observed",
        changed: true,
        firstDrift: true,
        metric: "drift",
        commitRef: "7c3d91a",
        sourceSpan: "tools/checkout.ts:10-30",
      },
    ],
  };

  const sampleCliReport: CliReportJson = {
    schemaVersion: 1,
    sessionId: "bp-9a8b7c6d",
    outcome: "candidate_confirmed",
    state: "cleaned_up",
    bounds: {
      goodInputRef: "v1.0.0",
      goodSha: "1111111111111111111111111111111111111111",
      badInputRef: "main",
      badSha: "4444444444444444444444444444444444444444",
    },
    candidateSha: "3333333333333333333333333333333333333333",
    parentSha: "2222222222222222222222222222222222222222",
    skippedShas: [],
    explanation: "Git named commit 3333333333333333333333333333333333333333 as the first bad commit.",
    evaluations: [
      {
        commitSha: "2222222222222222222222222222222222222222",
        classification: "good",
        reasonCode: "oracle_passed",
        detail: "Passed integration tests",
        gitExitCode: 0,
      },
      {
        commitSha: "3333333333333333333333333333333333333333",
        classification: "bad",
        reasonCode: "oracle_failed_expected_regression",
        detail: "Failed test: answer === 42",
        gitExitCode: 1,
      },
    ],
  };

  it("validates a valid Scenario object", () => {
    assert.equal(isValidScenario(sampleScenario), true);
    assert.equal(isValidScenario(null), false);
    assert.equal(isValidScenario({}), false);
    assert.equal(isValidScenario({ ...sampleScenario, turns: [] }), false);
  });

  it("identifies a valid CLI report object", () => {
    assert.equal(isCliReportJson(sampleCliReport), true);
    assert.equal(isCliReportJson(null), false);
    assert.equal(isCliReportJson({ sessionId: "bp-1" }), false);
  });

  it("imports a valid existing Scenario without modification via normalizeImportedJson", () => {
    const res = normalizeImportedJson(sampleScenario);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.sourceFormat, "scenario");
    assert.equal(res.scenario.id, "incident-triage");
    assert.equal(res.scenario.turns.length, 2);
  });

  it("imports and converts a valid CLI report into a Scenario representation", () => {
    const res = normalizeImportedJson(sampleCliReport);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.sourceFormat, "cli_report");
    const s = res.scenario;
    assert.equal(s.id, "bp-9a8b7c6d");
    assert.equal(s.currentRunId, "bp-9a8b7c6d");
    assert.equal(s.baselineRunId, "11111111");
    assert.equal(s.commit, "3333333");
    assert.equal(s.model, "candidate_confirmed");
    assert.equal(s.firstDriftTurn, "02"); // Step 02 is candidateSha / first bad
    assert.equal(s.driftScore, "1.00");

    // 2 evaluations + 1 conclusion turn = 3 turns
    assert.equal(s.turns.length, 3);
    const turn1 = s.turns[0]!;
    assert.equal(turn1.id, "01");
    assert.equal(turn1.kind, "tool");
    assert.equal(turn1.changed, false);
    assert.equal(turn1.metric, "good");

    const turn2 = s.turns[1]!;
    assert.equal(turn2.id, "02");
    assert.equal(turn2.kind, "result");
    assert.equal(turn2.changed, true);
    assert.equal(turn2.firstDrift, true);
    assert.equal(turn2.metric, "bad");

    const conclusionTurn = s.turns[2]!;
    assert.equal(conclusionTurn.id, "03");
    assert.equal(conclusionTurn.kind, "result");
    assert.ok(conclusionTurn.currentOutput.includes("candidate_confirmed"));
  });

  it("handles absent optional fields in CLI report gracefully", () => {
    const minimalReport: CliReportJson = {
      sessionId: "bp-minimal",
      outcome: "inconclusive",
      state: "cleaned_up",
    };
    const res = normalizeImportedJson(minimalReport);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.sourceFormat, "cli_report");
    assert.equal(res.scenario.id, "bp-minimal");
    assert.equal(res.scenario.baselineRunId, "baseline");
    assert.equal(res.scenario.turns.length, 1);
    assert.equal(res.scenario.firstDriftTurn, "01");
  });

  it("rejects malformed or unsupported JSON cleanly", () => {
    const invalidFormats = [
      {},
      { foo: "bar" },
      { name: "incomplete" },
      { id: "123", turns: [{ id: "1" }] }, // missing baseline/currentOutput
      "string-payload",
      12345,
    ];
    for (const item of invalidFormats) {
      const res = normalizeImportedJson(item);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.error.includes("Import rejected"));
      }
    }
  });
});
