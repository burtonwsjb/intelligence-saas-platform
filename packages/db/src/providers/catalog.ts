import { parseIspEnv } from "@isp/shared";
import {
  PROVIDER_KEYS,
  PROVIDER_MODES,
  type ProviderKey,
  type ProviderMode,
  type ProviderType,
} from "../schema/provider.js";

export { PROVIDER_KEYS, PROVIDER_MODES, type ProviderKey, type ProviderMode, type ProviderType };

export const PROVIDER_NORMALIZER_VERSION = "provider.normalize.v1";
export const SENTIMENT_ANALYZER_VERSION = "source.sentiment.v1";
export const MARKET_NORMALIZER_VERSION = "tcg.market.normalize.v1";
export const SOURCE_NORMALIZER_VERSION = "source.intelligence.normalize.v1";

export const PROVIDER_ENV_MODE: Record<ProviderKey, string> = {
  tcg_card_central: "PROVIDER_TCG_CARD_CENTRAL_MODE",
  tcgplayer: "PROVIDER_TCGPLAYER_MODE",
  ebay: "PROVIDER_EBAY_MODE",
  reddit: "PROVIDER_REDDIT_MODE",
  youtube: "PROVIDER_YOUTUBE_MODE",
};

export const PROVIDER_TYPE_BY_KEY: Record<ProviderKey, ProviderType> = {
  tcg_card_central: "market",
  tcgplayer: "market",
  ebay: "market",
  reddit: "social",
  youtube: "social",
};

export const PROVIDER_ADAPTER_NOTES: Record<ProviderKey, string> = {
  tcg_card_central:
    "First-party snapshot contract only. There is no public TCC marketplace SDK in this repo.",
  tcgplayer:
    "Native product pricing when product IDs are supplied. Unbounded catalog crawl is not implemented.",
  ebay: "Bounded Browse search. Unbounded marketplace crawl is not implemented.",
  reddit: "Topic search discovers posts and communities. Subreddit lists are optional seeds, not required.",
  youtube: "Topic search discovers videos and channel IDs. Channel ID lists are optional seeds, not required.",
};

export const DEFAULT_SCHEDULE_SECONDS: Record<ProviderKey, number> = {
  tcg_card_central: 300,
  tcgplayer: 300,
  ebay: 600,
  reddit: 900,
  youtube: 1800,
};

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as readonly string[]).includes(value);
}

export function isProviderMode(value: string): value is ProviderMode {
  return (PROVIDER_MODES as readonly string[]).includes(value);
}

export function defaultProviderMode(env: NodeJS.ProcessEnv = process.env): ProviderMode {
  const isp = parseIspEnv(env);
  if (isp === "local" || isp === "test") {
    return "fixture";
  }
  return "disabled";
}

/**
 * Live is never inferred from credential presence. Staging and production stay
 * disabled unless PROVIDER_*_MODE=live is set explicitly.
 */
export function resolveProviderMode(providerKey: ProviderKey, env: NodeJS.ProcessEnv = process.env): ProviderMode {
  const explicit = env[PROVIDER_ENV_MODE[providerKey]]?.trim().toLowerCase();
  if (explicit && isProviderMode(explicit)) {
    return explicit;
  }
  const fallback = env.PROVIDER_DEFAULT_MODE?.trim().toLowerCase();
  if (fallback && isProviderMode(fallback)) {
    return fallback;
  }
  return defaultProviderMode(env);
}

export type CredentialPresence = {
  present: boolean;
  status: "present" | "missing" | "disabled_pending_credentials";
  variables: string[];
};

export function credentialPresence(names: string[], env: NodeJS.ProcessEnv = process.env): CredentialPresence {
  const present = names.every((name) => Boolean(env[name]?.trim()));
  return {
    present,
    status: present ? "present" : "disabled_pending_credentials",
    variables: names,
  };
}

export const PROVIDER_CREDENTIAL_VARS: Record<ProviderKey, string[]> = {
  tcg_card_central: ["TCC_API_BASE_URL", "TCC_API_TOKEN"],
  tcgplayer: ["TCGPLAYER_PUBLIC_KEY", "TCGPLAYER_PRIVATE_KEY"],
  ebay: ["EBAY_OAUTH_TOKEN"],
  reddit: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"],
  youtube: ["YOUTUBE_API_KEY"],
};

export function providerCredentialStatus(
  providerKey: ProviderKey,
  env: NodeJS.ProcessEnv = process.env,
): CredentialPresence {
  return credentialPresence(PROVIDER_CREDENTIAL_VARS[providerKey], env);
}

export const PROVIDER_RETENTION = {
  raw_provider_payloads: "bounded_ingest_row; no browser exposure; no secret fields",
  normalized_content: "reference_or_bounded_excerpt",
  engagement_snapshots: "indefinite_derived",
  market_observations: "indefinite_immutable",
  failed_records: "until_operator_dismiss",
  quarantine: "until_operator_resolve_or_dismiss",
  provider_logs: "error_class_only_no_payload_secrets",
} as const;
