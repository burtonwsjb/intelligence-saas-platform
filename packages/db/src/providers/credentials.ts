import { PROVIDER_CREDENTIAL_VARS, PROVIDER_KEYS, PROVIDER_RETENTION, providerCredentialStatus, resolveProviderMode } from "./catalog.js";

export type CredentialReadinessRow = {
  provider: string;
  credential: string;
  environment_variable: string;
  required: "required" | "optional";
  where_obtained: string;
  secret_or_config: "secret" | "config";
  staging_required_now: boolean;
  live_calls_possible_without_it: boolean;
  configured: boolean;
  mode: string;
};

const WHERE_OBTAINED: Record<string, string> = {
  TCC_API_BASE_URL: "TCG Card Central versioned API host (operator-provided).",
  TCC_API_TOKEN: "TCG Card Central commercial API token.",
  TCGPLAYER_PUBLIC_KEY: "TCGplayer developer application public key.",
  TCGPLAYER_PRIVATE_KEY: "TCGplayer developer application private key.",
  TCGPLAYER_API_BASE_URL: "Optional TCGplayer API host override.",
  EBAY_OAUTH_TOKEN: "eBay application OAuth user/application token with sold/completed scope.",
  EBAY_APP_ID: "Optional eBay app id for token exchange.",
  EBAY_CERT_ID: "Optional eBay cert id for token exchange.",
  EBAY_API_BASE_URL: "Optional eBay API host override.",
  REDDIT_CLIENT_ID: "Reddit installed/web application client id.",
  REDDIT_CLIENT_SECRET: "Reddit application secret.",
  REDDIT_USER_AGENT: "Required Reddit user-agent identifying this platform.",
  REDDIT_SUBREDDITS: "Optional comma-separated subreddit allowlist.",
  YOUTUBE_API_KEY: "Google Cloud YouTube Data API v3 key.",
  YOUTUBE_CHANNEL_IDS: "Optional seed channel ids only. Topic search does not require them.",
  TCGPLAYER_PRODUCT_IDS: "Optional bounded TCGplayer product id seeds. No catalog crawl.",
  EBAY_SEARCH_QUERY: "Optional bounded eBay Browse search query.",
  CREATOR_LLM_API_KEY: "Optional LLM provider key for assisted extraction only.",
  CREATOR_LLM_PROVIDER: "Optional LLM provider name. Domain stays vendor-neutral.",
  CREATOR_LLM_MODEL: "Optional model identifier recorded in extractor version.",
};

const OPTIONAL = new Set([
  "TCGPLAYER_API_BASE_URL",
  "EBAY_APP_ID",
  "EBAY_CERT_ID",
  "EBAY_API_BASE_URL",
  "REDDIT_SUBREDDITS",
  "YOUTUBE_CHANNEL_IDS",
  "TCGPLAYER_PRODUCT_IDS",
  "EBAY_SEARCH_QUERY",
  "CREATOR_LLM_API_KEY",
  "CREATOR_LLM_PROVIDER",
  "CREATOR_LLM_MODEL",
]);

export function credentialReadinessReport(env: NodeJS.ProcessEnv = process.env): CredentialReadinessRow[] {
  const rows: CredentialReadinessRow[] = [];
  for (const provider of PROVIDER_KEYS) {
    const mode = resolveProviderMode(provider, env);
    const required = PROVIDER_CREDENTIAL_VARS[provider];
    const extras =
      provider === "tcgplayer"
        ? ["TCGPLAYER_API_BASE_URL", "TCGPLAYER_PRODUCT_IDS"]
        : provider === "ebay"
          ? ["EBAY_APP_ID", "EBAY_CERT_ID", "EBAY_API_BASE_URL", "EBAY_SEARCH_QUERY"]
          : provider === "reddit"
            ? ["REDDIT_SUBREDDITS"]
            : provider === "youtube"
              ? ["YOUTUBE_CHANNEL_IDS"]
              : [];
    for (const variable of [...required, ...extras]) {
      const optional = OPTIONAL.has(variable);
      rows.push({
        provider,
        credential: variable,
        environment_variable: variable,
        required: optional ? "optional" : "required",
        where_obtained: WHERE_OBTAINED[variable] ?? "Operator-provided.",
        secret_or_config: /TOKEN|KEY|SECRET|PASSWORD/.test(variable) ? "secret" : "config",
        staging_required_now: false,
        live_calls_possible_without_it: optional,
        configured: Boolean(env[variable]?.trim()),
        mode,
      });
    }
  }
  for (const variable of ["CREATOR_LLM_PROVIDER", "CREATOR_LLM_API_KEY", "CREATOR_LLM_MODEL"]) {
    rows.push({
      provider: "creator_llm",
      credential: variable,
      environment_variable: variable,
      required: "optional",
      where_obtained: WHERE_OBTAINED[variable] ?? "Operator-provided.",
      secret_or_config: /KEY/.test(variable) ? "secret" : "config",
      staging_required_now: false,
      live_calls_possible_without_it: true,
      configured: Boolean(env[variable]?.trim()),
      mode: env.CREATOR_LLM_MODE?.trim() || "disabled",
    });
  }
  return rows;
}

export function formatCredentialReadinessReport(env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    "Provider credential readiness (values are never printed)",
    `Retention: ${PROVIDER_RETENTION.raw_provider_payloads}`,
  ];
  for (const row of credentialReadinessReport(env)) {
    const present = providerCredentialStatus(
      row.provider === "creator_llm" ? "youtube" : (row.provider as (typeof PROVIDER_KEYS)[number]),
      env,
    );
    void present;
    lines.push(
      [
        `Provider: ${row.provider}`,
        `Credential: ${row.credential}`,
        `Environment variable: ${row.environment_variable}`,
        `Required/Optional: ${row.required}`,
        `Where obtained: ${row.where_obtained}`,
        `Secret/Config: ${row.secret_or_config}`,
        `Staging required now: ${row.staging_required_now ? "yes" : "no"}`,
        `Live calls possible without it: ${row.live_calls_possible_without_it ? "yes" : "no"}`,
        `Configured: ${row.configured ? "yes" : "no"}`,
        `Mode: ${row.mode}`,
      ].join("\n"),
    );
    lines.push("");
  }
  return lines.join("\n");
}
