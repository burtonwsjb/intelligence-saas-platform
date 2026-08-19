import { z } from "zod";
import { CREATOR_CALL_DIRECTIONS, CREATOR_CALL_HORIZONS, CREATOR_EXTRACTOR_VERSION } from "@isp/contracts";

export const CreatorCallCandidate = z.object({
  is_call: z.literal(true),
  direction: z.enum(CREATOR_CALL_DIRECTIONS),
  target_price: z.number().finite().nullable().optional(),
  target_percent: z.number().finite().nullable().optional(),
  horizon_code: z.enum(CREATOR_CALL_HORIZONS).default("unspecified"),
  horizon_custom_days: z.number().positive().nullable().optional(),
  stated_confidence: z.number().min(0).max(1).nullable().optional(),
  extraction_confidence: z.number().min(0).max(1),
  extractor_version: z.literal(CREATOR_EXTRACTOR_VERSION).optional(),
});
