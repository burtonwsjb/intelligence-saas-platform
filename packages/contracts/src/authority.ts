export const CREATOR_TRUST_STATES = [
  "trusted",
  "reliable",
  "developing",
  "low_confidence",
  "unreliable",
  "excluded",
] as const;
export type CreatorTrustState = (typeof CREATOR_TRUST_STATES)[number];

export const CREATOR_OUTCOME_VERSION = "outcome.v1";
export const CREATOR_AUTHORITY_VERSION = "authority.v1";
export const CREATOR_EARLY_CALL_VERSION = "early_call.v1";
export const CREATOR_BENCHMARK_REQUIREMENT = "phase_13_language_era_set_tier_index";
