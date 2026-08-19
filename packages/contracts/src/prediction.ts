export const PREDICTION_HORIZONS = ["7d", "30d", "90d", "180d", "365d"] as const;
export type PredictionHorizon = (typeof PREDICTION_HORIZONS)[number];

export const PREDICTION_MODEL_KEY = "stats.baseline" as const;
export const PREDICTION_MODEL_VERSION = "stats.baseline.v1" as const;
export const PREDICTION_VISIBILITY = ["shadow", "internal", "published"] as const;
export type PredictionVisibility = (typeof PREDICTION_VISIBILITY)[number];
export const DEFAULT_PREDICTION_VISIBILITY = "shadow" as const;
