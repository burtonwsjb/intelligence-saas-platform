export const INTELLIGENCE_REGRESSION_SCENARIOS = [
  "normal_market",
  "thin_market",
  "outlier_sale",
  "manipulated_spike",
  "mixed_currencies",
  "graded_ungraded",
  "multiple_languages",
  "ambiguous_card_name",
  "same_collector_number_across_sets",
  "same_card_across_variants",
  "conflicting_creators",
  "stale_social_signal",
  "viral_social_without_market",
  "market_move_without_social",
] as const;

export type IntelligenceRegressionScenario = (typeof INTELLIGENCE_REGRESSION_SCENARIOS)[number];

export const INTELLIGENCE_INVARIANTS = {
  predictionsRemainShadow: true,
  scoresRemainExplainable: true,
  scoresRemainUncalibratedWithoutLiveOutcomes: true,
  mixedCurrencyFailsClosed: true,
  languagesDoNotCollapse: true,
  variantsDoNotCollapse: true,
  futureDataCannotEnterCutoff: true,
  socialHypeIsNotMarketConfirmation: true,
} as const;

export function assertExplainableScore(scored: {
  explanations: Array<{ code: string; text: string }>;
  uncalibrated?: boolean;
  recommendation: string;
}) {
  if (scored.explanations.length < 1) {
    throw new Error("score_missing_explanations");
  }
  if (scored.uncalibrated === false) {
    throw new Error("score_claimed_calibrated");
  }
  if (!scored.recommendation) {
    throw new Error("score_missing_recommendation");
  }
}

export function assertShadowPrediction(row: { visibility?: string | null } | null | undefined) {
  if (!row) {
    return;
  }
  if (row.visibility !== "shadow") {
    throw new Error("prediction_not_shadow");
  }
}
