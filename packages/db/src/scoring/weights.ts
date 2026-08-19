export const SCORE_POLICY_KEY = "tcg.opportunity" as const;
export const SCORE_POLICY_VERSION = "score.v1" as const;
export const RECOMMENDATION_VERSION = "recommendation.v1" as const;

export const SCORE_UNCALIBRATED = true as const;

export const OPPORTUNITY_WEIGHTS_V1 = {
  price_momentum: 0.22,
  volume_momentum: 0.18,
  sales_velocity: 0.12,
  relative_strength: 0.16,
  supply_absorption: 0.14,
  creator_consensus: 0.12,
  social_momentum: 0.06,
} as const;

export const RISK_WEIGHTS_V1 = {
  volatility: 0.2,
  thin_liquidity: 0.16,
  spread: 0.1,
  low_sample: 0.14,
  outlier_dependence: 0.1,
  social_unconfirmed: 0.12,
  supply_shock: 0.1,
  creator_disagreement: 0.08,
} as const;

export const CONFIDENCE_WEIGHTS_V1 = {
  market_sample: 0.28,
  source_coverage: 0.12,
  freshness: 0.18,
  resolution_certainty: 0.14,
  creator_reliability: 0.14,
  cross_source: 0.14,
} as const;

export const LIQUIDITY_WEIGHTS_V1 = {
  sales_frequency: 0.28,
  intersale_time: 0.18,
  listing_depth: 0.16,
  spread: 0.14,
  seller_diversity: 0.12,
  historical_sales: 0.12,
} as const;

export const RECOMMENDATION_THRESHOLDS_V1 = {
  strong_buy: { opportunity: 75, risk_max: 40, confidence: 60, liquidity: 55 },
  buy: { opportunity: 60, risk_max: 50, confidence: 50, liquidity: 45 },
  watch: { opportunity: 50, risk_max: 65 },
  hold_min_opportunity: 40,
  reduce: { opportunity_max: 40, risk: 55 },
  sell: { opportunity_max: 35, risk: 65 },
  strong_sell: { opportunity_max: 30, risk: 80 },
  insufficient_confidence: 25,
  insufficient_sample: 3,
} as const;

export const SOCIAL_STRONG_BUY_CAP = 55;
export const MIN_SALES_FOR_MARKET_CONFIRM = 3;
