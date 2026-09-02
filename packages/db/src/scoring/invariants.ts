import {
  CONFIDENCE_WEIGHTS_V1,
  LIQUIDITY_WEIGHTS_V1,
  OPPORTUNITY_WEIGHTS_V1,
  RISK_WEIGHTS_V1,
  SCORE_UNCALIBRATED,
} from "./weights.js";
import type { ComponentContribution } from "./model.js";

export function weightSum(weights: Record<string, number>): number {
  return Object.values(weights).reduce((sum, value) => sum + value, 0);
}

export function assertPolicyWeightsSumToOne(): void {
  for (const [name, weights] of [
    ["opportunity", OPPORTUNITY_WEIGHTS_V1],
    ["risk", RISK_WEIGHTS_V1],
    ["confidence", CONFIDENCE_WEIGHTS_V1],
    ["liquidity", LIQUIDITY_WEIGHTS_V1],
  ] as const) {
    const sum = weightSum(weights);
    if (Math.abs(sum - 1) > 1e-9) {
      throw new Error(`${name}_weights_must_sum_to_one:${sum}`);
    }
  }
}

export function assertScoreBounds(scored: {
  opportunity: number;
  risk: number;
  confidence: number;
  liquidity: number;
  uncalibrated: boolean;
  explanations: unknown[];
}): void {
  for (const key of ["opportunity", "risk", "confidence", "liquidity"] as const) {
    const value = scored[key];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`score_out_of_bounds:${key}`);
    }
  }
  if (scored.uncalibrated !== SCORE_UNCALIBRATED) {
    throw new Error("score_must_remain_uncalibrated");
  }
  if (!Array.isArray(scored.explanations) || scored.explanations.length === 0) {
    throw new Error("score_missing_explanations");
  }
}

export function assertMissingWeightRedistribution(components: ComponentContribution[]): void {
  const present = components.filter((row) => row.present && row.score != null);
  const applied = present.reduce((sum, row) => sum + row.applied_weight, 0);
  if (present.length === 0) {
    return;
  }
  if (Math.abs(applied - 1) > 1e-6) {
    throw new Error(`applied_weights_must_sum_to_one:${applied}`);
  }
  for (const row of components) {
    if (!row.present && row.applied_weight !== 0) {
      throw new Error(`missing_input_must_have_zero_applied_weight:${row.key}`);
    }
  }
}

export function compareScoreVersions<T extends { opportunity: number; risk: number; recommendation: string; scoreVersion: string }>(
  current: T,
  candidate: T,
) {
  return {
    currentVersion: current.scoreVersion,
    candidateVersion: candidate.scoreVersion,
    opportunityDelta: candidate.opportunity - current.opportunity,
    riskDelta: candidate.risk - current.risk,
    recommendationChanged: current.recommendation !== candidate.recommendation,
    shadowOnly: true,
    calibrated: false,
  };
}
