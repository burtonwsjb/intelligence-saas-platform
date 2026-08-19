import { isTcgLanguageCode, isTcgVariantKey, normalizeCollectorNumber, normalizeTcgName } from "../tcg/identity.js";

export const ENTITY_RESOLUTION_STATES = [
  "exact",
  "high_confidence",
  "probable",
  "ambiguous",
  "unresolved",
  "conflict",
] as const;
export type EntityResolutionState = (typeof ENTITY_RESOLUTION_STATES)[number];

export const ENTITY_RESOLUTION_LAYERS = ["printing", "concept", "generic_entity"] as const;
export type EntityResolutionLayer = (typeof ENTITY_RESOLUTION_LAYERS)[number];

export const ENTITY_RESOLUTION_SUBJECT_TYPES = ["mention", "provider_reference", "manual"] as const;
export type EntityResolutionSubjectType = (typeof ENTITY_RESOLUTION_SUBJECT_TYPES)[number];

export const ENTITY_RESOLUTION_REVIEW_ACTIONS = [
  "accept_candidate",
  "reject_candidate",
  "mark_unresolved",
  "correct_mapping",
] as const;
export type EntityResolutionReviewAction = (typeof ENTITY_RESOLUTION_REVIEW_ACTIONS)[number];

export const RESOLVER_VERSION = "resolver.v1";
export const FUZZY_HIGH_THRESHOLD = 0.85;
export const FUZZY_PROBABLE_THRESHOLD = 0.78;

export class EntityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityResolutionError";
  }
}

export type EntityResolutionExternalId = {
  source_namespace: string;
  identifier_type: string;
  identifier_value: string;
};

export type ResolutionSignals = {
  game?: string | null;
  card_name?: string | null;
  set?: string | null;
  collector_number?: string | null;
  language?: string | null;
  variant?: string | null;
  rarity?: string | null;
  finish?: string | null;
  external_id?: EntityResolutionExternalId | null;
  promo?: boolean | null;
  context_text?: string | null;
  content_language?: string | null;
};

export type ScoredCandidate = {
  printingId: string;
  conceptId: string;
  score: number;
  matched: string[];
  conflicting: string[];
  evidence: string[];
  nameSimilarity: number;
};

export function parseSubjectType(value: string): EntityResolutionSubjectType {
  if (!(ENTITY_RESOLUTION_SUBJECT_TYPES as readonly string[]).includes(value)) {
    throw new EntityResolutionError("subject_type is invalid.");
  }
  return value as EntityResolutionSubjectType;
}

export function parseStatus(value: string): EntityResolutionState {
  if (!(ENTITY_RESOLUTION_STATES as readonly string[]).includes(value)) {
    throw new EntityResolutionError("resolution status is invalid.");
  }
  return value as EntityResolutionState;
}

export function parseReviewAction(value: string): EntityResolutionReviewAction {
  if (!(ENTITY_RESOLUTION_REVIEW_ACTIONS as readonly string[]).includes(value)) {
    throw new EntityResolutionError("review action is invalid.");
  }
  return value as EntityResolutionReviewAction;
}

export function mayBindPrinting(status: EntityResolutionState): boolean {
  return status === "exact" || status === "high_confidence";
}

export function normalizeMatchText(value: string): string {
  return normalizeTcgName(value).toLocaleLowerCase("en");
}

export function collectorMatches(input: string, storedNormalized: string): boolean {
  const a = normalizeCollectorNumber(input);
  const b = storedNormalized;
  if (a === b) {
    return true;
  }
  const left = (value: string) => value.split("/")[0] ?? value;
  if (left(a) === left(b)) {
    return true;
  }
  return false;
}

export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0]![j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  return matrix[a.length]![b.length]!;
}

export function editSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function tokenSet(value: string): Set<string> {
  return new Set(normalizeMatchText(value).split(/[\s·・/._-]+/).filter(Boolean));
}

export function tokenDice(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (left.size + right.size);
}

export function primaryScript(value: string): "latin" | "cjk" | "other" {
  let latin = 0;
  let cjk = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    }
  }
  if (cjk > 0 && latin === 0) {
    return "cjk";
  }
  if (latin > 0 && cjk === 0) {
    return "latin";
  }
  if (cjk > 0 && latin > 0) {
    return "other";
  }
  return cjk >= latin ? "cjk" : latin > 0 ? "latin" : "other";
}

export function nameSimilarity(query: string, candidate: string): number {
  const a = normalizeMatchText(query);
  const b = normalizeMatchText(candidate);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const scriptA = primaryScript(a);
  const scriptB = primaryScript(b);
  if (scriptA !== "other" && scriptB !== "other" && scriptA !== scriptB) {
    return 0;
  }
  return Math.max(editSimilarity(a, b), tokenDice(a, b));
}

export function optionalSignal(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function asLanguageSignal(value: string | null | undefined): string | undefined {
  const trimmed = optionalSignal(value);
  if (!trimmed) {
    return undefined;
  }
  return isTcgLanguageCode(trimmed) ? trimmed : undefined;
}

export function asVariantSignal(value: string | null | undefined): string | undefined {
  const trimmed = optionalSignal(value);
  if (!trimmed) {
    return undefined;
  }
  return isTcgVariantKey(trimmed) ? trimmed : undefined;
}
