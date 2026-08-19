import { describe, expect, it } from "vitest";
import {
  ALPHA_METHOD_VERSION,
  BENCHMARK_RESOLVER_VERSION,
  DEFAULT_INDEX_WEIGHTING,
  INDEX_METHOD_VERSION,
  MARKET_FEATURE_SET_KEY,
  MARKET_RETURN_PERIODS,
} from "./analytics.js";

describe("analytics contracts", () => {
  it("versions collectible feature, index, and alpha methods separately", () => {
    expect(MARKET_FEATURE_SET_KEY).toBe("tcg.market.features");
    expect(MARKET_RETURN_PERIODS).toEqual(["1d", "7d", "30d", "90d", "180d", "365d"]);
    expect(DEFAULT_INDEX_WEIGHTING).toBe("equal.v1");
    expect(INDEX_METHOD_VERSION).toBe("index.v1");
    expect(ALPHA_METHOD_VERSION).toBe("alpha.v1");
    expect(BENCHMARK_RESOLVER_VERSION).toBe("benchmark.v1");
  });
});
