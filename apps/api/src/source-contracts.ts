import { z } from "zod";
import {
  SOURCE_CONTENT_TYPES,
  SOURCE_EVENT_TYPES,
  SOURCE_LICENSE_STATUSES,
  SOURCE_MENTION_CONTEXTS,
  SOURCE_RETENTION_POLICIES,
  SOURCE_SEGMENT_KINDS,
  SOURCE_SENTIMENTS,
  SOURCE_TYPES,
} from "@isp/contracts";

export const SourceContentRecord = z.object({
  provider: z.enum(SOURCE_TYPES),
  provider_record_id: z.string().min(1),
  event_type: z.enum(SOURCE_EVENT_TYPES),
  account: z.object({
    external_account_id: z.string().min(1),
    handle: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    canonical_url: z.string().url().nullable().optional(),
  }),
  content: z.object({
    external_content_id: z.string().min(1),
    content_type: z.enum(SOURCE_CONTENT_TYPES),
    published_at: z.string().datetime(),
    title: z.string().nullable().optional(),
    summary: z.string().max(500).nullable().optional(),
    canonical_url: z.string().url(),
    language: z.string().nullable().optional(),
    license_status: z.enum(SOURCE_LICENSE_STATUSES).optional(),
    retention_policy: z.enum(SOURCE_RETENTION_POLICIES).optional(),
    transcript_available: z.boolean().optional(),
    excerpt: z.string().max(500).nullable().optional(),
  }),
  segments: z
    .array(
      z.object({
        kind: z.enum(SOURCE_SEGMENT_KINDS),
        start_ref: z.string().nullable().optional(),
        end_ref: z.string().nullable().optional(),
        excerpt: z.string().max(500).nullable().optional(),
      }),
    )
    .optional(),
  mentions: z
    .array(
      z.object({
        raw_entity_text: z.string().min(1),
        mention_context: z.enum(SOURCE_MENTION_CONTEXTS).optional(),
        candidate_direction: z.string().nullable().optional(),
        candidate_timeframe: z.string().nullable().optional(),
        candidate_price: z.number().finite().nullable().optional(),
        candidate_percent: z.number().finite().nullable().optional(),
        sentiment: z.enum(SOURCE_SENTIMENTS).optional(),
        sentiment_confidence: z.number().min(0).max(1).nullable().optional(),
        segment_index: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .optional(),
});
