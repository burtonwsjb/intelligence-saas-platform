import { z } from "zod";
import {
  INDEX_STATUSES,
  INDEX_WEIGHTING_METHODS,
  MARKET_DATA_QUALITY_STATES,
  MARKET_FEATURE_SET_KEY,
  MARKET_FEATURE_SET_VERSION,
  MARKET_OUTLIER_POLICIES,
  MARKET_RETURN_PERIODS,
} from "@isp/contracts";

export const MarketReturnPeriod = z.enum(MARKET_RETURN_PERIODS);
export const MarketOutlierPolicy = z.enum(MARKET_OUTLIER_POLICIES);
export const MarketDataQualityState = z.enum(MARKET_DATA_QUALITY_STATES);

export const MarketFeatureSnapshotContract = z.object({
  printing_id: z.string().min(1),
  as_of: z.string().datetime(),
  feature_set_key: z.literal(MARKET_FEATURE_SET_KEY),
  feature_set_version: z.literal(MARKET_FEATURE_SET_VERSION),
  language: z.string().min(1),
  condition: z.string().min(1),
  outlier_policy: MarketOutlierPolicy,
  data_quality: MarketDataQualityState,
  sample_size: z.number().int().nonnegative(),
  features: z.record(z.string(), z.unknown()),
});

export const IndexDefinitionContract = z.object({
  index_key: z.string().min(1),
  name: z.string().min(1),
  game: z.string().min(1),
  language: z.string().nullable(),
  weighting_method: z.enum(INDEX_WEIGHTING_METHODS),
  status: z.enum(INDEX_STATUSES),
  membership_rule: z.record(z.string(), z.unknown()),
});
