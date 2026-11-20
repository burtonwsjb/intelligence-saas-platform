import Link from "next/link";

export const metadata = { title: "API docs · Sentiment" };

const BASE = "https://api.socialsignaliq.com";

type Endpoint = { path: string; scope: string; what: string; params?: string };

const GROUPS: { title: string; endpoints: Endpoint[] }[] = [
  {
    title: "Buy/sell signals and search",
    endpoints: [
      {
        path: "/v1/signals",
        scope: "signals:read",
        what: "Cards ranked by buy/sell reading, influencer lean or price, each with its latest price, price change over the window, a price series and the influencer sentiment summary. Also the way to search cards by name.",
        params:
          "q (name search), game, set, language, variant, market=buy|hold|sell|none, social=positive|negative|neutral|any|none, sort=market_buy (default) | market_sell | opportunity | risk_low | confidence | liquidity | price_high | price_low | name | social_positive | social_negative | social_posts, window=7d|30d|90d, page (1–500), page_size (1–48, default 24)",
      },
    ],
  },
  {
    title: "Cards, sets and products",
    endpoints: [
      { path: "/v1/printings", scope: "cards:read", what: "Exact printings (card + set + language + variant). This id is what the other card endpoints take.", params: "game, set, language, variant, limit (1–100), cursor" },
      { path: "/v1/printings/{id}", scope: "cards:read", what: "One printing." },
      { path: "/v1/cards", scope: "cards:read", what: "Card concepts (a card across all its printings).", params: "game, limit, cursor" },
      { path: "/v1/cards/{id}", scope: "cards:read", what: "One card concept." },
      { path: "/v1/sets", scope: "cards:read", what: "Sets.", params: "game, limit, cursor" },
      { path: "/v1/products", scope: "cards:read", what: "Sealed products: booster packs, boxes, bundles, elite trainer boxes.", params: "kind, game, set" },
      { path: "/v1/markets", scope: "markets:read", what: "Games and languages covered." },
    ],
  },
  {
    title: "Prices and history",
    endpoints: [
      { path: "/v1/printings/{id}/prices", scope: "prices:read", what: "Latest price. Money is in major units (USD 40.00 is 40) with an explicit currency." },
      { path: "/v1/printings/{id}/market-history", scope: "markets:read", what: "Sold and listing history for charts.", params: "source, condition, grade, from, to (ISO dates), limit, cursor" },
      { path: "/v1/indices", scope: "markets:read", what: "Market index definitions." },
      { path: "/v1/indices/{index_key}/history", scope: "markets:read", what: "Index history." },
    ],
  },
  {
    title: "Sentiment",
    endpoints: [
      { path: "/v1/printings/{id}/sentiment", scope: "signals:read", what: "Accuracy-weighted influencer sentiment for a card with its history over time, how many calls came true, and chart sentiment (what the price, demand and population charts say).", params: "window=7d|30d|90d" },
      { path: "/v1/products/{key}/sentiment", scope: "signals:read", what: "The same for a sealed product, with its latest price.", params: "window" },
      { path: "/v1/printings/{id}/signals", scope: "signals:read", what: "Market signal flags for a card." },
      { path: "/v1/printings/{id}/opportunity", scope: "opportunities:read", what: "Opportunity, risk, confidence and liquidity scores and the buy/sell recommendation." },
    ],
  },
  {
    title: "Influencers",
    endpoints: [
      { path: "/v1/creators", scope: "creators:read", what: "Influencer profiles." },
      { path: "/v1/creators/leaderboard", scope: "creators:read", what: "Influencers ranked by how many of their last 12 months of calls came true.", params: "game" },
      { path: "/v1/creators/{id}", scope: "creators:read", what: "One influencer's accuracy summary." },
      { path: "/v1/creators/{id}/calls", scope: "creators:read", what: "That influencer's calls and how each one turned out." },
    ],
  },
];

const SIGNALS_EXAMPLE = `{
  "data": [
    {
      "printing_id": "prn_…",
      "game": "pokemon",
      "name": "Charizard ex",
      "set": { "key": "…", "name": "Obsidian Flames" },
      "collector_number": "125",
      "language": "en",
      "variant": "normal",
      "image_url": "https://…",
      "reading": {
        "recommendation": "buy",
        "opportunity": 72.5, "risk": 31.0, "confidence": 64.0, "liquidity": 80.0,
        "as_of": "2026-11-20T08:00:00.000Z"
      },
      "price": { "amount": "41.20", "currency": "USD", "unit": "major", "quote_type": "reference", "observed_at": "…" },
      "price_change": 0.0812,
      "price_series": [{ "observed_at": "…", "amount": 38.1 }],
      "social": { "label": "leaning_positive", "posts": 9, "rated_posts": 6, "accounts": 5 }
    }
  ],
  "page": 1, "page_size": 24, "page_count": 12, "total": 281,
  "window": { "key": "30d", "from": "…", "to": "…" },
  "request_id": "…"
}`;

export default function DevelopersPage() {
  return (
    <article className="legal">
      <h1>Sentiment API</h1>
      <p>
        Read Sentiment&apos;s trading card data from your own code: buy/sell readings, influencer sentiment and accuracy,
        prices and price history, cards, sets and sealed products. The API is read-only and versioned under{" "}
        <code>/v1</code>; fields are only added within a version, never removed or renamed.
      </p>

      <h2>Getting a key</h2>
      <p>
        Keys are issued by Sentiment, or made by a workspace owner on the API keys page in the app. A key is shown once
        when it is made, so store it right away. Keep it on your server: anyone with the key can spend your requests. If
        a key leaks, ask for it to be rotated or revoked.
      </p>

      <h2>Making a request</h2>
      <p>
        Base URL: <code>{BASE}</code>. Send the key as a bearer token.
      </p>
      <pre>
        <code>{`curl -H "Authorization: Bearer $SENTIMENT_API_KEY" \\
  "${BASE}/v1/signals?market=buy&game=pokemon&page_size=10"`}</code>
      </pre>
      <pre>
        <code>{`const res = await fetch("${BASE}/v1/printings/" + id + "/sentiment?window=30d", {
  headers: { Authorization: \`Bearer \${process.env.SENTIMENT_API_KEY}\` },
});
const body = await res.json();`}</code>
      </pre>

      <h2>Limits</h2>
      <ul>
        <li>
          Each key can have a per-minute limit. Every response then carries <code>X-RateLimit-Limit</code>,{" "}
          <code>X-RateLimit-Remaining</code> and <code>X-RateLimit-Reset</code> (seconds until the minute resets). Over
          the limit you get <code>429 rate_limited</code> with a <code>Retry-After</code> header.
        </li>
        <li>
          Requests also count toward your workspace plan&apos;s monthly allowance. Past it you get{" "}
          <code>429 quota_exceeded</code> until the next month or an upgrade.
        </li>
        <li>Data refreshes daily for prices and scores and through the day for influencer posts, so caching responses for an hour or more is safe.</li>
      </ul>

      <h2>Errors</h2>
      <p>
        Errors are JSON: <code>{`{ "error": { "code", "message", "request_id" } }`}</code>.
      </p>
      <ul>
        <li><code>400 validation_error</code>: an unknown or malformed query parameter.</li>
        <li><code>401 unauthorized</code>: missing, wrong, expired or revoked key.</li>
        <li><code>403 scope_denied</code>: the key does not have the scope this endpoint needs.</li>
        <li><code>403 tenant_suspended</code>: the workspace is suspended.</li>
        <li><code>404 not_found</code>: no such card, set, product or influencer.</li>
        <li><code>429 rate_limited</code> or <code>429 quota_exceeded</code>: see Limits.</li>
      </ul>

      <h2>Paging</h2>
      <p>
        List endpoints return <code>data</code>, <code>next_cursor</code> and <code>has_more</code>; pass{" "}
        <code>cursor=&lt;next_cursor&gt;</code> for the next page. <code>/v1/signals</code> uses <code>page</code> and{" "}
        <code>page_size</code> instead and returns <code>total</code> and <code>page_count</code>.
      </p>

      <h2>Endpoints</h2>
      <p>
        All are <code>GET</code>. The scope is what the key needs. The machine-readable list is at{" "}
        <a href={`${BASE}/v1/openapi.json`}>{`${BASE}/v1/openapi.json`}</a>.
      </p>
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <ul>
            {group.endpoints.map((endpoint) => (
              <li key={endpoint.path}>
                <code>{endpoint.path}</code> <span className="subtle">· {endpoint.scope}</span>
                <br />
                {endpoint.what}
                {endpoint.params ? (
                  <>
                    <br />
                    <span className="subtle">Parameters: {endpoint.params}</span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <h2>Example: /v1/signals</h2>
      <p>
        <code>price_change</code> is a fraction (0.0812 is +8.1%) between the first and last comparable prices in the
        window. <code>reading.opportunity</code> is null when the card has no opportunity input yet.
      </p>
      <pre>
        <code>{SIGNALS_EXAMPLE}</code>
      </pre>

      <h2>Terms</h2>
      <p>
        Use of the API is covered by the <Link href="/api-terms">API Terms</Link>. Sentiment readings are information, not
        investment advice.
      </p>
    </article>
  );
}
