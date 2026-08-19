import { z } from "zod";
import {
  TCG_LANGUAGE_CODES,
  TCG_VARIANT_KEYS,
} from "@isp/contracts";

const statusSchema = z.enum(["active", "disabled"]);

export const tcgLanguageCodeSchema = z.enum(TCG_LANGUAGE_CODES);
export const tcgVariantKeySchema = z.enum(TCG_VARIANT_KEYS);

export const TcgGame = z.object({
  game_key: z.string().min(1),
  display_name: z.string().min(1),
  publisher: z.string().nullable().optional(),
  status: statusSchema,
});

export const TcgLanguage = z.object({
  language_code: tcgLanguageCodeSchema,
  display_name: z.string().min(1),
  required: z.boolean(),
});

export const TcgSet = z.object({
  id: z.string().min(1),
  game_key: z.string().min(1),
  canonical_set_key: z.string().min(1),
  name: z.string().min(1),
  language_scope: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  status: statusSchema,
});

export const TcgCard = z.object({
  id: z.string().min(1),
  game_key: z.string().min(1),
  concept_key: z.string().min(1),
  canonical_name: z.string().min(1),
  normalized_name: z.string().min(1),
  status: statusSchema,
});

export const TcgPrinting = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  set_id: z.string().min(1),
  game_key: z.string().min(1),
  collector_number: z.string().min(1),
  collector_number_normalized: z.string().min(1),
  language: tcgLanguageCodeSchema,
  variant_key: tcgVariantKeySchema,
  rarity: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  edition: z.string().nullable().optional(),
  promo: z.boolean(),
  canonical_printing_key: z.string().min(1),
  status: statusSchema,
});

export const TcgPrintingIdentifier = z.object({
  id: z.string().min(1),
  printing_id: z.string().min(1),
  source_namespace: z.string().min(1),
  identifier_type: z.string().min(1),
  identifier_value: z.string().min(1),
  normalized_value: z.string().min(1),
});

export const TcgPrintingReference = z.object({
  game: z.string().min(1),
  set: z.string().min(1),
  collector_number: z.string().min(1),
  language: tcgLanguageCodeSchema,
  variant: tcgVariantKeySchema,
  concept_key: z.string().min(1).optional(),
});
