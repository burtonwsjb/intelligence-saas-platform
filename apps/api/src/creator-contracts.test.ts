import { describe, expect, it } from "vitest";
import { CreatorCallCandidate } from "./creator-contracts.js";

describe("creator call Zod contracts", () => {
  it("accepts bounded directions and rejects invented horizons", () => {
    expect(
      CreatorCallCandidate.parse({
        is_call: true,
        direction: "bullish",
        horizon_code: "30d",
        extraction_confidence: 0.8,
      }).direction,
    ).toBe("bullish");
    expect(
      CreatorCallCandidate.safeParse({
        is_call: true,
        direction: "long",
        extraction_confidence: 0.8,
      }).success,
    ).toBe(false);
  });
});
