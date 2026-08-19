import { describe, expect, it } from "vitest";
import { RECOMMENDATION_LABELS, SCORE_POLICY_KEY, SCORE_POLICY_VERSION } from "./scoring.js";

describe("scoring contracts", () => {
  it("keeps recommendation labels and uncalibrated v1 policy versioned", () => {
    expect(SCORE_POLICY_KEY).toBe("tcg.opportunity");
    expect(SCORE_POLICY_VERSION).toBe("score.v1");
    expect(RECOMMENDATION_LABELS).toContain("strong_buy");
    expect(RECOMMENDATION_LABELS).toContain("insufficient_data");
  });
});
