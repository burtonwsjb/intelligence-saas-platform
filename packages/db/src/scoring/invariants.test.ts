import { describe, expect, it } from "vitest";
import { scoreFromInputs, type ScoreInputs } from "./model.js";
import { SCORE_POLICY_VERSION } from "./weights.js";
import {
  assertMissingWeightRedistribution,
  assertPolicyWeightsSumToOne,
  assertScoreBounds,
  compareScoreVersions,
} from "./invariants.js";
import { emptyScoreCalibrationReport, historicalOutcomeInterface } from "./calibration.js";

function baseInput(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    printingId: "prn_en",
    languageCode: "en",
    asOf: "2026-01-30T00:00:00.000Z",
    sampleSize: 20,
    dataQuality: "complete",
    stalenessHours: 12,
    sourceCount: 2,
    resolutionCertainty: 1,
    returns: { "7d": { status: "ok", value: 0.07 }, "30d": { status: "ok", value: 0.12 } },
    volumeMomentum: { status: "ok", value: 0.48 },
    salesVelocity: { sales_7d: 8, sales_30d: 24, sales_per_day_30d: { status: "ok", value: 0.8 } },
    supply: { listing_count: 10, listing_change: -4, seller_count: 7, absorption_ratio: { status: "ok", value: 0.8 } },
    relativeStrength: { status: "ok", value: 0.062 },
    volatility: { status: "ok", value: 0.04 },
    latestSpreadRatio: 1.05,
    ...overrides,
  };
}

describe("scoring invariants", () => {
  it("keeps published weights summing to one and scores inside 0-100", () => {
    assertPolicyWeightsSumToOne();
    const scored = scoreFromInputs(baseInput());
    assertScoreBounds(scored);
    assertMissingWeightRedistribution(scored.components.opportunity);
  });

  it("is monotonic in 30d return for otherwise identical inputs", () => {
    const low = scoreFromInputs(baseInput({ returns: { "7d": { status: "ok", value: 0.01 }, "30d": { status: "ok", value: 0.02 } } }));
    const high = scoreFromInputs(baseInput({ returns: { "7d": { status: "ok", value: 0.01 }, "30d": { status: "ok", value: 0.2 } } }));
    expect(high.opportunity).toBeGreaterThan(low.opportunity);
  });

  it("compares score versions in shadow without claiming calibration", () => {
    const current = scoreFromInputs(baseInput());
    const candidate = scoreFromInputs(baseInput({ scoreVersion: "score.v2-shadow" }));
    const diff = compareScoreVersions(
      { ...current, scoreVersion: SCORE_POLICY_VERSION },
      { ...candidate, scoreVersion: "score.v2-shadow" },
    );
    expect(diff.shadowOnly).toBe(true);
    expect(diff.calibrated).toBe(false);
    expect(emptyScoreCalibrationReport([]).calibrated).toBe(false);
    expect(historicalOutcomeInterface({ scoreId: "s1", asOf: new Date("2026-01-01T00:00:00.000Z"), horizonDays: 30 }).lookAhead).toBe(
      false,
    );
  });
});
