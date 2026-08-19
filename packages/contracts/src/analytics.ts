export const MARKET_FEATURE_SET_KEY = "tcg.market.features" as const;
export const MARKET_FEATURE_SET_VERSION = "features.v1" as const;

export const MARKET_RETURN_PERIODS = ["1d", "7d", "30d", "90d", "180d", "365d"] as const;
export type MarketReturnPeriod = (typeof MARKET_RETURN_PERIODS)[number];

export const MARKET_OUTLIER_POLICIES = ["exclude_flagged.v1", "include_all.v1"] as const;
export type MarketOutlierPolicy = (typeof MARKET_OUTLIER_POLICIES)[number];

export const MARKET_DATA_QUALITY_STATES = [
  "complete",
  "partial",
  "insufficient_data",
  "stale",
  "outlier_dependent",
] as const;
export type MarketDataQualityState = (typeof MARKET_DATA_QUALITY_STATES)[number];

export const INDEX_WEIGHTING_METHODS = ["equal.v1", "liquidity.v1"] as const;
export type IndexWeightingMethod = (typeof INDEX_WEIGHTING_METHODS)[number];

export const INDEX_STATUSES = ["active", "disabled"] as const;
export type IndexStatus = (typeof INDEX_STATUSES)[number];

export const INDEX_REBALANCE_SCHEDULES = ["daily", "weekly", "monthly", "manual"] as const;
export type IndexRebalanceSchedule = (typeof INDEX_REBALANCE_SCHEDULES)[number];

export const DEFAULT_INDEX_WEIGHTING = "equal.v1" as const;
export const INDEX_METHOD_VERSION = "index.v1" as const;
export const INDEX_BASE_VALUE = 100 as const;

export const ALPHA_METHOD_VERSION = "alpha.v1" as const;
export const BENCHMARK_RESOLVER_VERSION = "benchmark.v1" as const;

export const ANALYTICS_METRIC_STATUS = ["ok", "insufficient_data"] as const;
export type AnalyticsMetricStatus = (typeof ANALYTICS_METRIC_STATUS)[number];
