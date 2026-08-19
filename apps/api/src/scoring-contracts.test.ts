import { describe, expect, it } from "vitest";
import { OpportunityScoreContract } from "./scoring-contracts.js";

describe("scoring contracts", () => {
  it("requires separate scores, a recommendation, and explanations", () => {
    const parsed = OpportunityScoreContract.parse({
      printing_id: "prn",
      as_of: "2026-01-04T00:00:00.000Z",
      opportunity: 72,
      risk: 31,
      confidence: 64,
      liquidity: 58,
      recommendation: "buy",
      policy_key: "tcg.opportunity",
      policy_version: "score.v1",
      explanations: [{ code: "volume_momentum", text: "sales volume +48%", refs: ["features.v1"] }],
    });
    expect(parsed.recommendation).toBe("buy");
    expect(parsed.opportunity).not.toBe(parsed.risk);
  });
});
