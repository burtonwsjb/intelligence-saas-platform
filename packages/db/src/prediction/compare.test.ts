import { describe, expect, it } from "vitest";
import {
  assertPredictionsRemainShadow,
  comparePredictionModelRuns,
  mapeForPricePairs,
} from "./compare.js";

describe("prediction evaluation invariants", () => {
  it("forbids customer publication and does not invent accuracy", () => {
    expect(() => assertPredictionsRemainShadow([{ visibility: "shadow" }])).not.toThrow();
    expect(() => assertPredictionsRemainShadow([{ visibility: "customer" }])).toThrow(/publication_forbidden/);
    const comparison = comparePredictionModelRuns({
      current: { modelVersion: "stats.v1", mae: 0.1, n: 4 },
      candidate: { modelVersion: "stats.v2-shadow", mae: 0.09, n: 4 },
    });
    expect(comparison.calibrated).toBe(false);
    expect(comparison.customerVisible).toBe(false);
    expect(mapeForPricePairs([{ actual: 40, predicted: 44 }])).toBeCloseTo(0.1);
  });
});
