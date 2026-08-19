import { describe, expect, it } from "vitest";
import { IndexDefinitionContract, MarketFeatureSnapshotContract } from "./analytics-contracts.js";

describe("analytics contracts", () => {
  it("accepts versioned feature snapshots and generalized index specs", () => {
    const snapshot = MarketFeatureSnapshotContract.parse({
      printing_id: "prn_1",
      as_of: "2026-01-03T00:00:00.000Z",
      feature_set_key: "tcg.market.features",
      feature_set_version: "features.v1",
      language: "en",
      condition: "nm",
      outlier_policy: "exclude_flagged.v1",
      data_quality: "partial",
      sample_size: 3,
      features: { returns: {} },
    });
    expect(snapshot.language).toBe("en");
    const index = IndexDefinitionContract.parse({
      index_key: "pokemon.language.ja",
      name: "Japanese Pokémon Index",
      game: "pokemon",
      language: "ja",
      weighting_method: "equal.v1",
      status: "active",
      membership_rule: { language_code: "ja" },
    });
    expect(index.language).toBe("ja");
  });
});
