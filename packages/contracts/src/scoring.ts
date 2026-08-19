export const SCORE_POLICY_KEY = "tcg.opportunity" as const;
export const SCORE_POLICY_VERSION = "score.v1" as const;
export const RECOMMENDATION_VERSION = "recommendation.v1" as const;

export const RECOMMENDATION_LABELS = [
  "strong_buy",
  "buy",
  "watch",
  "hold",
  "reduce",
  "sell",
  "strong_sell",
  "insufficient_data",
] as const;
export type RecommendationLabel = (typeof RECOMMENDATION_LABELS)[number];
