import {
  PREDICTION_HORIZON_DAYS,
  PREDICTION_MODEL_KEY,
  PREDICTION_MODEL_VERSION,
  type PredictionHorizon,
} from "./catalog.js";

export type FrozenFeatures = {
  printingId: string;
  languageCode: string;
  asOf: Date;
  priceAtIssue: number | null;
  sampleSize: number;
  dataQuality: string;
  return7d: number | null;
  return30d: number | null;
  volatility: number | null;
  featureSnapshotId: string | null;
  featureSetVersion: string | null;
};

export type ForecastOutput = {
  expectedReturn: number | null;
  returnRangeLow: number | null;
  returnRangeHigh: number | null;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  probabilityIncrease: number | null;
  probabilityDecline: number | null;
  confidence: number;
  risk: number;
  dataQuality: string;
  components: Record<string, unknown>;
};

export type PredictionModel = {
  key: string;
  version: string;
  predict(features: FrozenFeatures, horizon: PredictionHorizon): ForecastOutput;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function logistic(x: number) {
  return 1 / (1 + Math.exp(-x));
}

export const statsBaselineV1: PredictionModel = {
  key: PREDICTION_MODEL_KEY,
  version: PREDICTION_MODEL_VERSION,
  predict(features, horizon) {
    const days = PREDICTION_HORIZON_DAYS[horizon];
    const base =
      features.return30d != null ? features.return30d : features.return7d != null ? features.return7d : null;
    const scale = Math.sqrt(days / 30);
    const expected = base == null ? null : base * (days / (features.return30d != null ? 30 : 7));
    const vol = features.volatility == null ? 0.12 : features.volatility;
    const band = vol * 1.5 * scale;
    const low = expected == null ? null : expected - band;
    const high = expected == null ? null : expected + band;
    const pUp =
      expected == null ? 0.5 : clamp(logistic(expected / 0.08), 0.05, 0.95);
    const confidence = clamp(
      20 + Math.min(features.sampleSize, 20) * 3 + (features.dataQuality === "complete" ? 15 : 0),
      5,
      90,
    );
    const risk = clamp(vol * 400, 10, 95);
    let quality = features.dataQuality;
    if (features.priceAtIssue == null || expected == null || features.sampleSize < 2) {
      quality = "insufficient_data";
    }
    return {
      expectedReturn: expected,
      returnRangeLow: low,
      returnRangeHigh: high,
      priceRangeLow:
        features.priceAtIssue != null && low != null ? features.priceAtIssue * (1 + low) : null,
      priceRangeHigh:
        features.priceAtIssue != null && high != null ? features.priceAtIssue * (1 + high) : null,
      probabilityIncrease: pUp,
      probabilityDecline: 1 - pUp,
      confidence,
      risk,
      dataQuality: quality,
      components: {
        model: PREDICTION_MODEL_VERSION,
        horizon_days: days,
        center_from: features.return30d != null ? "return_30d" : features.return7d != null ? "return_7d" : "none",
        opportunity_score_reused: false,
        look_ahead: false,
      },
    };
  },
};

export const noChangeBaseline: PredictionModel = {
  key: "baseline.no_change",
  version: "baseline.no_change.v1",
  predict(features) {
    return {
      expectedReturn: 0,
      returnRangeLow: -0.05,
      returnRangeHigh: 0.05,
      priceRangeLow: features.priceAtIssue,
      priceRangeHigh: features.priceAtIssue,
      probabilityIncrease: 0.5,
      probabilityDecline: 0.5,
      confidence: 30,
      risk: 40,
      dataQuality: features.priceAtIssue == null ? "insufficient_data" : features.dataQuality,
      components: { model: "baseline.no_change.v1" },
    };
  },
};

export const momentumBaseline: PredictionModel = {
  key: "baseline.momentum",
  version: "baseline.momentum.v1",
  predict(features, horizon) {
    return statsBaselineV1.predict(
      { ...features, return30d: null, return7d: features.return7d },
      horizon,
    );
  },
};

export function getModel(version: string = PREDICTION_MODEL_VERSION): PredictionModel {
  if (version === noChangeBaseline.version) {
    return noChangeBaseline;
  }
  if (version === momentumBaseline.version) {
    return momentumBaseline;
  }
  return statsBaselineV1;
}
