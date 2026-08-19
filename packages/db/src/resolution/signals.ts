import { isTcgLanguageCode, isTcgVariantKey } from "../tcg/identity.js";
import {
  asLanguageSignal,
  asVariantSignal,
  optionalSignal,
  type ResolutionSignals,
} from "./identity.js";

const LANGUAGE_TOKEN_MAP: Array<[RegExp, string]> = [
  [/\bsimplified chinese\b/i, "zh-Hans"],
  [/\btraditional chinese\b/i, "zh-Hant"],
  [/\bzh-hans\b/i, "zh-Hans"],
  [/\bzh-hant\b/i, "zh-Hant"],
  [/\bjapanese\b/i, "ja"],
  [/\benglish\b/i, "en"],
  [/\bchinese\b/i, "zh-Hans"],
  [/\b日本語\b/, "ja"],
  [/\b简体\b/, "zh-Hans"],
  [/\b简中\b/, "zh-Hans"],
  [/\b繁体\b/, "zh-Hant"],
  [/\b\bjp\b/i, "ja"],
  [/\bja\b/i, "ja"],
  [/\ben\b/i, "en"],
];

const VARIANT_TOKEN_MAP: Array<[RegExp, string]> = [
  [/\breverse[_\s-]?holo\b/i, "reverse_holo"],
  [/\bholofoil\b/i, "holofoil"],
  [/\bholo\b/i, "holofoil"],
  [/\balt[_\s-]?art\b/i, "alt_art"],
  [/\bfirst[_\s-]?edition\b/i, "first_edition"],
  [/\bpromo\b/i, "promo"],
  [/\bnormal\b/i, "normal"],
];

const COLLECTOR_PATTERN =
  /\b((?:tg)?\d{1,3}\/(?:tg)?\d{1,3}|\d{1,4}\/\d{1,4}|p-\d{1,4}|\d{2,4})\b/i;

export type CatalogHints = {
  sets: Array<{ canonicalSetKey: string; name: string }>;
  names: string[];
};

export function inferLanguageFromText(text: string): string | undefined {
  for (const [pattern, code] of LANGUAGE_TOKEN_MAP) {
    if (pattern.test(text) && isTcgLanguageCode(code)) {
      return code;
    }
  }
  return undefined;
}

export function inferVariantFromText(text: string): string | undefined {
  for (const [pattern, key] of VARIANT_TOKEN_MAP) {
    if (pattern.test(text) && isTcgVariantKey(key)) {
      return key;
    }
  }
  return undefined;
}

export function inferCollectorFromText(text: string): string | undefined {
  const match = text.match(COLLECTOR_PATTERN);
  return match?.[1];
}

export function inferSetFromText(
  text: string,
  sets: CatalogHints["sets"] | undefined,
): string | undefined {
  const lower = text.toLocaleLowerCase("en");
  for (const set of Array.isArray(sets) ? sets : []) {
    if (lower.includes(set.name.toLocaleLowerCase("en")) || lower.includes(set.canonicalSetKey)) {
      return set.canonicalSetKey;
    }
  }
  return undefined;
}

export function stripIdentityTokens(text: string, hints: CatalogHints): string {
  let remaining = text;
  remaining = remaining.replace(COLLECTOR_PATTERN, " ");
  for (const set of hints.sets ?? []) {
    remaining = remaining.replace(new RegExp(set.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
    remaining = remaining.replace(new RegExp(`\\b${set.canonicalSetKey}\\b`, "ig"), " ");
  }
  remaining = remaining.replace(/\b(japanese|english|chinese|simplified|traditional|jp|ja|en)\b/gi, " ");
  remaining = remaining.replace(/日本語|简体|简中|繁体/g, " ");
  remaining = remaining.replace(/\b(reverse[_\s-]?holo|holofoil|holo|alt[_\s-]?art|promo|normal)\b/gi, " ");
  remaining = remaining.replace(/\s+/g, " ").trim();
  return remaining;
}

export function inferSignalsFromText(text: string, hints: CatalogHints): ResolutionSignals {
  const collector = inferCollectorFromText(text);
  const set = inferSetFromText(text, hints.sets);
  const language = inferLanguageFromText(text);
  const variant = inferVariantFromText(text);
  const name = stripIdentityTokens(text, hints);
  return {
    card_name: name || undefined,
    set,
    collector_number: collector,
    language,
    variant,
    context_text: text,
  };
}

export function mergeSignals(
  explicit: ResolutionSignals,
  inferred: ResolutionSignals,
): ResolutionSignals {
  return {
    game: optionalSignal(explicit.game) ?? optionalSignal(inferred.game),
    card_name: optionalSignal(explicit.card_name) ?? optionalSignal(inferred.card_name),
    set: optionalSignal(explicit.set) ?? optionalSignal(inferred.set),
    collector_number:
      optionalSignal(explicit.collector_number) ?? optionalSignal(inferred.collector_number),
    language: asLanguageSignal(explicit.language) ?? asLanguageSignal(inferred.language),
    variant: asVariantSignal(explicit.variant) ?? asVariantSignal(inferred.variant),
    rarity: optionalSignal(explicit.rarity) ?? optionalSignal(inferred.rarity),
    finish: optionalSignal(explicit.finish) ?? optionalSignal(inferred.finish),
    external_id: explicit.external_id ?? inferred.external_id ?? null,
    promo: explicit.promo ?? inferred.promo ?? null,
    context_text: optionalSignal(explicit.context_text) ?? optionalSignal(inferred.context_text),
    content_language: asLanguageSignal(explicit.content_language),
  };
}
