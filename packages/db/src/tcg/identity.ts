export const TCG_GAME_KEYS = [
  "pokemon",
  "one_piece",
  "magic",
  "lorcana",
  "yugioh",
  "other",
] as const;

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

export const TCG_ENTITY_TYPE = "tcg_printing";
export const TCG_SOURCE_NAMESPACE = "tcg";
export const TCG_PRINTING_IDENTIFIER_TYPE = "canonical_printing_key";

export class TcgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TcgValidationError";
  }
}

export class TcgIdentifierConflictError extends Error {
  constructor() {
    super("Printing identifier is already bound to a different printing.");
    this.name = "TcgIdentifierConflictError";
  }
}

export function isTcgLanguageCode(value: string): boolean {
  return (TCG_LANGUAGE_CODES as readonly string[]).includes(value);
}

export function isTcgVariantKey(value: string): boolean {
  return (TCG_VARIANT_KEYS as readonly string[]).includes(value);
}

export function parseTcgLanguage(value: unknown): string {
  if (typeof value !== "string" || !isTcgLanguageCode(value)) {
    throw new TcgValidationError("Language is required and must be a catalog BCP 47 code.");
  }
  return value;
}

export function parseTcgVariant(value: unknown): string {
  if (typeof value !== "string" || !isTcgVariantKey(value)) {
    throw new TcgValidationError("Variant is required and must be a canonical variant key.");
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
