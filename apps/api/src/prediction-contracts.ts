import { z } from "zod";
import {
  DEFAULT_PREDICTION_VISIBILITY,
  PREDICTION_HORIZONS,
  PREDICTION_MODEL_KEY,
  PREDICTION_MODEL_VERSION,
  PREDICTION_VISIBILITY,
} from "@isp/contracts";

export const PredictionHorizon = z.enum(PREDICTION_HORIZONS);
export const PredictionVisibility = z.enum(PREDICTION_VISIBILITY);

export const PredictionRecordContract = z.object({
  printing_id: z.string().min(1),
  issued_at: z.string().datetime(),
  data_cutoff_at: z.string().datetime(),
  horizon: PredictionHorizon,
  expected_return: z.number().nullable(),
  return_range_low: z.number().nullable(),
  return_range_high: z.number().nullable(),
  probability_increase: z.number().min(0).max(1).nullable(),
  probability_decline: z.number().min(0).max(1).nullable(),
  confidence: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
  model_key: z.string().min(1),
  model_version: z.string().min(1),
  visibility: PredictionVisibility,
  as_of: z.string().datetime(),
});

export const DefaultPredictionModelKey = PREDICTION_MODEL_KEY;
export const DefaultPredictionModelVersion = PREDICTION_MODEL_VERSION;
export const DefaultPredictionVisibility = DEFAULT_PREDICTION_VISIBILITY;
