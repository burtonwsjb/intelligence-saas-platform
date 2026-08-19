export const CREATOR_CALL_DIRECTIONS = [
  "bullish",
  "bearish",
  "neutral",
  "watch",
  "avoid",
  "unknown",
] as const;
export type CreatorCallDirection = (typeof CREATOR_CALL_DIRECTIONS)[number];

export const CREATOR_CALL_HORIZONS = ["7d", "30d", "90d", "180d", "365d", "custom", "unspecified"] as const;
export type CreatorCallHorizon = (typeof CREATOR_CALL_HORIZONS)[number];

export const CREATOR_CALL_STATUSES = ["extracted", "finalized", "superseded"] as const;
export type CreatorCallStatus = (typeof CREATOR_CALL_STATUSES)[number];

export const CREATOR_ACCOUNT_LINK_STATES = ["confirmed", "unresolved_ownership"] as const;
export type CreatorAccountLinkState = (typeof CREATOR_ACCOUNT_LINK_STATES)[number];

export const CREATOR_CALL_OUTCOME_STATES = ["pending", "ready", "evaluated", "insufficient_data"] as const;
export type CreatorCallOutcomeState = (typeof CREATOR_CALL_OUTCOME_STATES)[number];

export const CREATOR_EXTRACTOR_VERSION = "creator.extract.v1";
export const CREATOR_PRICE_AT_CALL_VERSION = "price_at_call.v1";
export const CREATOR_LLM_EXTRACTOR_VERSION = "creator.llm.fixture.v1";

export class CreatorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorContractError";
  }
}

export function isCreatorCallDirection(value: string): value is CreatorCallDirection {
  return (CREATOR_CALL_DIRECTIONS as readonly string[]).includes(value);
}

export function parseCreatorCallDirection(value: unknown): CreatorCallDirection {
  if (typeof value !== "string" || !isCreatorCallDirection(value)) {
    throw new CreatorContractError("call direction is invalid.");
  }
  return value;
}

export function parseCreatorCallHorizon(value: unknown): CreatorCallHorizon {
  if (typeof value !== "string" || !(CREATOR_CALL_HORIZONS as readonly string[]).includes(value)) {
    throw new CreatorContractError("call horizon is invalid.");
  }
  return value as CreatorCallHorizon;
}

export function mayBindCallPrinting(resolutionStatus: string): boolean {
  return resolutionStatus === "exact" || resolutionStatus === "high_confidence";
}
