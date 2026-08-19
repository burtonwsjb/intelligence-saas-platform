export const MARKET_FEATURE_SET_KEY = "tcg.market.features" as const;
export const MARKET_FEATURE_SET_VERSION = "features.v1" as const;

export const MARKET_RETURN_PERIODS = ["1d", "7d", "30d", "90d", "180d", "365d"] as const;
export type MarketReturnPeriod = (typeof MARKET_RETURN_PERIODS)[number];

export const MARKET_RETURN_DAYS: Record<MarketReturnPeriod, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

export const MARKET_OUTLIER_POLICIES = ["exclude_flagged.v1", "include_all.v1"] as const;
export type MarketOutlierPolicy = (typeof MARKET_OUTLIER_POLICIES)[number];

export const DEFAULT_OUTLIER_POLICY: MarketOutlierPolicy = "exclude_flagged.v1";

export const INDEX_WEIGHTING_METHODS = ["equal.v1", "liquidity.v1"] as const;
export type IndexWeightingMethod = (typeof INDEX_WEIGHTING_METHODS)[number];

export const DEFAULT_INDEX_WEIGHTING: IndexWeightingMethod = "equal.v1";
export const INDEX_METHOD_VERSION = "index.v1" as const;
export const INDEX_BASE_VALUE = 100;

export const ALPHA_METHOD_VERSION = "alpha.v1" as const;
export const BENCHMARK_RESOLVER_VERSION = "benchmark.v1" as const;

export const MS_DAY = 86_400_000;
