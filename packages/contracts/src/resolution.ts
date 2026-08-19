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

export const ENTITY_RESOLUTION_REVIEW_STATES = [
  "none",
  "needs_review",
  "accepted",
  "rejected",
  "unresolved_confirmed",
] as const;
export type EntityResolutionReviewState = (typeof ENTITY_RESOLUTION_REVIEW_STATES)[number];

export const ENTITY_RESOLUTION_REVIEW_ACTIONS = [
  "accept_candidate",
  "reject_candidate",
  "mark_unresolved",
  "correct_mapping",
] as const;
export type EntityResolutionReviewAction = (typeof ENTITY_RESOLUTION_REVIEW_ACTIONS)[number];

export const ENTITY_RESOLUTION_EVIDENCE = [
  "external_id_exact",
  "collector_exact",
  "set_exact",
  "language_exact",
  "variant_exact",
  "game_exact",
  "name_exact",
  "name_language_alias",
  "name_similarity",
  "rarity_exact",
  "finish_exact",
  "promo_exact",
  "context_clue",
  "content_language_hint",
  "manual_review",
  "conflicting_attribute",
] as const;
export type EntityResolutionEvidenceCode = (typeof ENTITY_RESOLUTION_EVIDENCE)[number];

export const ENTITY_RESOLVER_VERSION = "resolver.v1";

export class EntityResolutionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityResolutionContractError";
  }
}

export type EntityResolutionExternalId = {
  source_namespace: string;
  identifier_type: string;
  identifier_value: string;
};

export type EntityResolutionSignals = {
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

export function isEntityResolutionState(value: string): value is EntityResolutionState {
  return (ENTITY_RESOLUTION_STATES as readonly string[]).includes(value);
}

export function parseEntityResolutionState(value: unknown): EntityResolutionState {
  if (typeof value !== "string" || !isEntityResolutionState(value)) {
    throw new EntityResolutionContractError("resolution status is invalid.");
  }
  return value;
}

export function parseEntityResolutionSubjectType(value: unknown): EntityResolutionSubjectType {
  if (
    typeof value !== "string" ||
    !(ENTITY_RESOLUTION_SUBJECT_TYPES as readonly string[]).includes(value)
  ) {
    throw new EntityResolutionContractError("subject_type is invalid.");
  }
  return value as EntityResolutionSubjectType;
}

export function parseEntityResolutionReviewAction(value: unknown): EntityResolutionReviewAction {
  if (
    typeof value !== "string" ||
    !(ENTITY_RESOLUTION_REVIEW_ACTIONS as readonly string[]).includes(value)
  ) {
    throw new EntityResolutionContractError("review action is invalid.");
  }
  return value as EntityResolutionReviewAction;
}

export function mayBindPrinting(status: EntityResolutionState): boolean {
  return status === "exact" || status === "high_confidence";
}

/**
 * Resolution confidence is independent of market-prediction confidence,
 * creator authority, and sentiment confidence.
 */
export function parseResolutionConfidence(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EntityResolutionContractError("resolution confidence must be 0..1.");
  }
  return value;
}
