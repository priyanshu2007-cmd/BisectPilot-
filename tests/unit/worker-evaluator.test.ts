import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasSampleEvaluator, type SampleEvaluatorEngine } from "../../src/worker/index.js";

describe("Worker — Sample Evaluator Typing & Fallback", () => {
  it("type guards engines that implement evaluateSample", () => {
    assert.equal(hasSampleEvaluator(null), false);
    assert.equal(hasSampleEvaluator(undefined), false);
    assert.equal(hasSampleEvaluator({}), false);
    assert.equal(hasSampleEvaluator({ evaluateSample: "not-a-func" }), false);
    assert.equal(hasSampleEvaluator({ evaluateSample: 42 }), false);

    const validEngine: SampleEvaluatorEngine = {
      evaluateSample: async () => ({
        outcome: "bad",
        measurement: 45.2,
        durationMs: 12,
      }),
    };
    assert.equal(hasSampleEvaluator(validEngine), true);

    if (hasSampleEvaluator(validEngine)) {
      // Confirms TypeScript narrows validEngine to SampleEvaluatorEngine
      assert.equal(typeof validEngine.evaluateSample, "function");
    }
  });

  it("invokes evaluateSample when present and returns typed measurement", async () => {
    let called = false;
    const engine: SampleEvaluatorEngine = {
      evaluateSample: async (_job, options) => {
        called = true;
        assert.ok(options?.signal);
        return {
          outcome: "bad",
          measurement: 99.9,
          durationMs: 50,
        };
      },
    };

    assert.ok(hasSampleEvaluator(engine));
    const result = await engine.evaluateSample({} as any, { signal: new AbortController().signal });
    assert.equal(called, true);
    assert.equal(result.outcome, "bad");
    assert.equal(result.measurement, 99.9);
  });
});
