export const PREDICTION_HORIZONS = ["7d", "30d", "90d", "180d", "365d"] as const;
export type PredictionHorizon = (typeof PREDICTION_HORIZONS)[number];

export const PREDICTION_HORIZON_DAYS: Record<PredictionHorizon, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

export const PREDICTION_MODEL_KEY = "stats.baseline" as const;
export const PREDICTION_MODEL_VERSION = "stats.baseline.v1" as const;
export const DEFAULT_PREDICTION_VISIBILITY = "shadow" as const;
export const CALIBRATION_VERSION = "calibration.v1" as const;
export const BACKTEST_VERSION = "walk_forward.v1" as const;
