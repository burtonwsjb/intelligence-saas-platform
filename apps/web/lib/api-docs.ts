/**
 * The customer data API lives on the engine (api.socialsignaliq.com) and is
 * called with a key issued from /app/keys or by an operator from
 * /admin/api-keys. This is the short reference both pages show.
 */
export function customerApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.API_URL?.trim() || env.NEXT_PUBLIC_API_URL?.trim();
  return (configured || "https://api.socialsignaliq.com").replace(/\/+$/, "");
}

export const SCOPE_LABELS: Record<string, string> = {
  "cards:read": "Cards and sets",
  "prices:read": "Prices",
  "markets:read": "Market history and indices",
  "signals:read": "Buy/sell sentiment",
  "creators:read": "Influencers and their calls",
  "predictions:read": "Forecasts",
  "opportunities:read": "Opportunity scores",
  "decisions:read": "Key check (/v1/me)",
  "webhooks:manage": "Webhooks (write)",
  "ingest:write": "Send events (write)",
};

export const CUSTOMER_API_ENDPOINTS: { path: string; scope: string; what: string }[] = [
  { path: "GET /v1/signals?market=buy&game=pokemon", scope: "signals:read", what: "Cards ranked by buy/sell reading, with price change" },
  { path: "GET /v1/cards?q=charizard&game=pokemon", scope: "cards:read", what: "Search cards" },
  { path: "GET /v1/sets", scope: "cards:read", what: "List sets" },
  { path: "GET /v1/printings/{id}", scope: "cards:read", what: "One exact printing" },
  { path: "GET /v1/printings/{id}/prices", scope: "prices:read", what: "Today's market price" },
  { path: "GET /v1/printings/{id}/market-history", scope: "markets:read", what: "Daily price history" },
  { path: "GET /v1/printings/{id}/sentiment", scope: "signals:read", what: "Buy/sell reading with evidence" },
  { path: "GET /v1/products/{key}/sentiment", scope: "signals:read", what: "Set, sealed or graded reading" },
  { path: "GET /v1/indices", scope: "markets:read", what: "Market indices" },
  { path: "GET /v1/creators/leaderboard", scope: "creators:read", what: "Influencers ranked by accuracy" },
  { path: "GET /v1/creators/{id}/calls", scope: "creators:read", what: "One influencer's scored calls" },
];
