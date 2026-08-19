import { z } from "zod";
import {
  ENTITY_RESOLUTION_LAYERS,
  ENTITY_RESOLUTION_REVIEW_ACTIONS,
  ENTITY_RESOLUTION_STATES,
  ENTITY_RESOLUTION_SUBJECT_TYPES,
  ENTITY_RESOLVER_VERSION,
} from "@isp/contracts";

export const EntityResolutionSignals = z.object({
  game: z.string().min(1).nullable().optional(),
  card_name: z.string().min(1).nullable().optional(),
  set: z.string().min(1).nullable().optional(),
  collector_number: z.string().min(1).nullable().optional(),
  language: z.string().min(1).nullable().optional(),
  variant: z.string().min(1).nullable().optional(),
  rarity: z.string().min(1).nullable().optional(),
  finish: z.string().min(1).nullable().optional(),
  external_id: z
    .object({
      source_namespace: z.string().min(1),
      identifier_type: z.string().min(1),
      identifier_value: z.string().min(1),
    })
    .nullable()
    .optional(),
  promo: z.boolean().nullable().optional(),
  context_text: z.string().nullable().optional(),
  content_language: z.string().nullable().optional(),
});

export const EntityResolutionRequest = z.object({
  subject_type: z.enum(ENTITY_RESOLUTION_SUBJECT_TYPES),
  subject_id: z.string().min(1),
  resolver_version: z.literal(ENTITY_RESOLVER_VERSION).optional(),
  signals: EntityResolutionSignals,
});

export const EntityResolutionReview = z.object({
  action: z.enum(ENTITY_RESOLUTION_REVIEW_ACTIONS),
  candidate_id: z.string().min(1).nullable().optional(),
  printing_id: z.string().min(1).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const EntityResolutionStatus = z.enum(ENTITY_RESOLUTION_STATES);
export const EntityResolutionLayer = z.enum(ENTITY_RESOLUTION_LAYERS);
