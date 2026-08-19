import { describe, expect, it } from "vitest";
import {
  DefaultPredictionVisibility,
  PredictionRecordContract,
} from "./prediction-contracts.js";

describe("prediction contracts", () => {
  it("requires ranges, probabilities, and a frozen as_of without a single price target", () => {
    const parsed = PredictionRecordContract.parse({
      printing_id: "prn",
      issued_at: "2026-01-04T00:00:00.000Z",
      data_cutoff_at: "2026-01-04T00:00:00.000Z",
      horizon: "30d",
      expected_return: 0.04,
      return_range_low: -0.1,
      return_range_high: 0.18,
      probability_increase: 0.62,
      probability_decline: 0.38,
      confidence: 48,
      risk: 41,
      model_key: "stats.baseline",
      model_version: "stats.baseline.v1",
      visibility: "shadow",
      as_of: "2026-01-04T00:00:00.000Z",
    });
    expect(parsed.visibility).toBe(DefaultPredictionVisibility);
    expect(parsed.expected_return).not.toBeNull();
    expect(parsed.return_range_low).toBeLessThan(parsed.return_range_high!);
  });
});
