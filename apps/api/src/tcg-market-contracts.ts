import { z } from "zod";
import {
  TCG_CONDITIONS,
  TCG_CURRENCIES,
  TCG_GRADING_COMPANIES,
  TCG_MARKET_AGGREGATION_KINDS,
  TCG_MARKET_EVENT_TYPES,
  TCG_MARKET_QUALITY_LABELS,
  TCG_MARKET_SOURCES,
  TCG_MARKET_TYPES,
  TCG_PRICE_TYPES,
} from "@isp/contracts";

export const TcgMarketRecord = z.object({
  provider: z.enum(TCG_MARKET_SOURCES),
  provider_record_id: z.string().min(1),
  event_type: z.enum(TCG_MARKET_EVENT_TYPES),
  market_type: z.enum(TCG_MARKET_TYPES),
  price_type: z.enum(TCG_PRICE_TYPES).optional(),
  observed_at: z.string().datetime(),
  currency: z.enum(TCG_CURRENCIES),
  condition: z.enum(TCG_CONDITIONS),
  raw_condition: z.string().optional(),
  grading_company: z.enum(TCG_GRADING_COMPANIES).nullable().optional(),
  grade_label: z.string().nullable().optional(),
  grade_numeric: z.number().finite().nullable().optional(),
  certification_number: z.string().nullable().optional(),
  price: z.number().positive().finite().nullable().optional(),
  quantity: z.number().int().nonnegative().nullable().optional(),
  listing_count: z.number().int().nonnegative().nullable().optional(),
  sales_count: z.number().int().nonnegative().nullable().optional(),
  volume_value: z.number().positive().finite().nullable().optional(),
  low_price: z.number().positive().finite().nullable().optional(),
  high_price: z.number().positive().finite().nullable().optional(),
  median_price: z.number().positive().finite().nullable().optional(),
  average_price: z.number().positive().finite().nullable().optional(),
  bid_count: z.number().int().nonnegative().nullable().optional(),
  seller_count: z.number().int().nonnegative().nullable().optional(),
  shipping_amount: z.number().nonnegative().finite().nullable().optional(),
  tax_amount: z.number().nonnegative().finite().nullable().optional(),
  fee_amount: z.number().nonnegative().finite().nullable().optional(),
  window_seconds: z.number().int().positive().nullable().optional(),
  aggregation_kind: z.enum(TCG_MARKET_AGGREGATION_KINDS).optional(),
  source_reference: z.string().nullable().optional(),
  printing: z
    .object({
      game: z.string().min(1).optional(),
      set: z.string().min(1).optional(),
      collector_number: z.string().min(1).optional(),
      language: z.string().min(1).optional(),
      variant: z.string().min(1).optional(),
    })
    .optional(),
  external_id: z
    .object({
      source_namespace: z.string().min(1),
      identifier_type: z.string().min(1),
      identifier_value: z.string().min(1),
    })
    .optional(),
  attributes: z.record(z.unknown()).optional(),
  quality_label: z.enum(TCG_MARKET_QUALITY_LABELS).optional(),
});
