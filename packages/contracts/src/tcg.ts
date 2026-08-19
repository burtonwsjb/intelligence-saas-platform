export const TCG_GAME_KEYS = [
  "pokemon",
  "one_piece",
  "magic",
  "lorcana",
  "yugioh",
  "other",
] as const;

export type TcgGameKey = (typeof TCG_GAME_KEYS)[number];

export const TCG_REQUIRED_LANGUAGES = ["en", "ja", "zh-Hans"] as const;

export const TCG_LANGUAGE_CODES = [
  "en",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "de",
  "fr",
  "es",
  "it",
  "pt",
] as const;

export type TcgLanguageCode = (typeof TCG_LANGUAGE_CODES)[number];

export const TCG_VARIANT_KEYS = [
  "normal",
  "holofoil",
  "reverse_holo",
  "parallel",
  "alt_art",
  "promo",
  "first_edition",
  "unlimited",
  "serialized",
  "special_finish",
] as const;

export type TcgVariantKey = (typeof TCG_VARIANT_KEYS)[number];

export const TCG_PRINTING_IDENTIFIER_TYPES = [
  "tcg_card_central_catalog_id",
  "tcgplayer_product_id",
  "ebay_reference_id",
  "manufacturer_id",
  "internal_legacy_id",
] as const;

export const TCG_RESOLUTION_STATES = ["exact", "ambiguous", "not_found", "conflict"] as const;

export type TcgResolutionState = (typeof TCG_RESOLUTION_STATES)[number];

export const TCG_ENTITY_TYPE = "tcg_printing";
export const TCG_SOURCE_NAMESPACE = "tcg";
export const TCG_PRINTING_IDENTIFIER_TYPE = "canonical_printing_key";

export const TCC_SANDBOX_OPERATIONS = [
  "GET /v1/cards/{id}",
  "GET /v1/printings/{id}",
  "POST /v1/printings/resolve",
  "GET /v1/sets/{id}",
] as const;

export type TcgGame = {
  game_key: TcgGameKey | string;
  display_name: string;
  publisher?: string | null;
  status: "active" | "disabled";
};

export type TcgLanguage = {
  language_code: string;
  display_name: string;
  required: boolean;
};

export type TcgSet = {
  id: string;
  game_key: string;
  canonical_set_key: string;
  name: string;
  language_scope?: string | null;
  release_date?: string | null;
  status: "active" | "disabled";
};

export type TcgCard = {
  id: string;
  game_key: string;
  concept_key: string;
  canonical_name: string;
  normalized_name: string;
  status: "active" | "disabled";
};

export type TcgPrinting = {
  id: string;
  card_id: string;
  set_id: string;
  game_key: string;
  collector_number: string;
  collector_number_normalized: string;
  language: string;
  variant_key: string;
  rarity?: string | null;
  finish?: string | null;
  edition?: string | null;
  promo: boolean;
  canonical_printing_key: string;
  status: "active" | "disabled";
};

export type TcgPrintingIdentifier = {
  id: string;
  printing_id: string;
  source_namespace: string;
  identifier_type: string;
  identifier_value: string;
  normalized_value: string;
};

export type TcgPrintingReference = {
  game: string;
  set: string;
  collector_number: string;
  language: string;
  variant: string;
  concept_key?: string;
};

export type TcgResolveQuery = {
  game?: string;
  set?: string;
  collector_number?: string;
  language?: string;
  variant?: string;
  external_id?: {
    source_namespace: string;
    identifier_type: string;
    identifier_value: string;
  };
};

export class TcgContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcgContractError";
  }
}

export function isTcgLanguageCode(value: string): value is TcgLanguageCode {
  return (TCG_LANGUAGE_CODES as readonly string[]).includes(value);
}

export function isTcgVariantKey(value: string): value is TcgVariantKey {
  return (TCG_VARIANT_KEYS as readonly string[]).includes(value);
}

export function isTcgGameKey(value: string): boolean {
  return (TCG_GAME_KEYS as readonly string[]).includes(value);
}

export function parseTcgLanguage(value: unknown): TcgLanguageCode {
  if (typeof value !== "string" || !isTcgLanguageCode(value)) {
    throw new TcgContractError("Language is required and must be a catalog BCP 47 code.");
  }
  return value;
}

export function parseTcgVariant(value: unknown): TcgVariantKey {
  if (typeof value !== "string" || !isTcgVariantKey(value)) {
    throw new TcgContractError("Variant is required and must be a canonical variant key.");
  }
  return value;
}

export function normalizeCollectorNumber(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeTcgName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function canonicalPrintingKey(input: {
  gameKey: string;
  conceptKey: string;
  setKey: string;
  collectorNormalized: string;
  language: string;
  variantKey: string;
}): string {
  return `tcg:${input.gameKey}:${input.conceptKey}:${input.setKey}:${input.collectorNormalized}:${input.language}:${input.variantKey}`;
}

export function kernelCanonicalKeyForPrinting(printingKey: string): string {
  return `${TCG_ENTITY_TYPE}:${TCG_SOURCE_NAMESPACE}:${TCG_PRINTING_IDENTIFIER_TYPE}:${printingKey}`;
}

export function parseTcgPrintingReference(input: TcgPrintingReference): TcgPrintingReference {
  const game = input.game?.trim();
  const set = input.set?.trim();
  const collector_number = input.collector_number;
  const language = parseTcgLanguage(input.language);
  const variant = parseTcgVariant(input.variant);
  if (!game) {
    throw new TcgContractError("game is required.");
  }
  if (!set) {
    throw new TcgContractError("set is required.");
  }
  if (typeof collector_number !== "string" || collector_number.trim() === "") {
    throw new TcgContractError("collector_number is required.");
  }
  return {
    game,
    set,
    collector_number,
    language,
    variant,
    concept_key: input.concept_key,
  };
}
