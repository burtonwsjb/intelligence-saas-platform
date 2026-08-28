export function commercialOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Intelligence Platform Commercial API",
      version: "v1",
      description: "Tenant-authenticated commercial intelligence API. Internal ingest and Stripe webhooks are not included.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "API key" },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/cards": { get: { summary: "List card concepts", security: [{ bearerAuth: [] }] } },
      "/v1/cards/{id}": { get: { summary: "Get a card concept", security: [{ bearerAuth: [] }] } },
      "/v1/printings": { get: { summary: "List exact printings", security: [{ bearerAuth: [] }] } },
      "/v1/printings/{id}": { get: { summary: "Get an exact printing", security: [{ bearerAuth: [] }] } },
      "/v1/sets": { get: { summary: "List sets", security: [{ bearerAuth: [] }] } },
      "/v1/printings/{id}/prices": {
        get: {
          summary: "Latest non-outlier sold price",
          description:
            "Monetary fields are major currency units (USD 40.00 is 40, not 4000 cents). `amount` is a decimal string; `price` is the same value as JSON number for compatibility; `unit` is always `major`; `currency` is ISO 4217.",
          security: [{ bearerAuth: [] }],
        },
      },
      "/v1/printings/{id}/market-history": {
        get: {
          summary: "Sold and listing history",
          description:
            "Sold `amount`/`price` and listing `amount`/`low_price` are major currency units with an explicit `currency` and `unit=major`. Outlier solds are included in history with `outlier=true`.",
          security: [{ bearerAuth: [] }],
        },
      },
      "/v1/printings/{id}/signals": { get: { summary: "Market signal flags", security: [{ bearerAuth: [] }] } },
      "/v1/printings/{id}/opportunity": { get: { summary: "Opportunity scores", security: [{ bearerAuth: [] }] } },
      "/v1/printings/{id}/predictions": { get: { summary: "Predictions (shadow-disabled)", security: [{ bearerAuth: [] }] } },
      "/v1/markets": { get: { summary: "Language-separated market catalogs", security: [{ bearerAuth: [] }] } },
      "/v1/indices": { get: { summary: "Index definitions", security: [{ bearerAuth: [] }] } },
      "/v1/indices/{index_key}": { get: { summary: "Index definition and latest point", security: [{ bearerAuth: [] }] } },
      "/v1/indices/{index_key}/history": { get: { summary: "Index history", security: [{ bearerAuth: [] }] } },
      "/v1/creators": { get: { summary: "Creator profiles", security: [{ bearerAuth: [] }] } },
      "/v1/creators/{id}": { get: { summary: "Creator authority summary", security: [{ bearerAuth: [] }] } },
      "/v1/creators/{id}/calls": { get: { summary: "Creator calls", security: [{ bearerAuth: [] }] } },
      "/v1/webhooks": {
        get: { summary: "List webhook endpoints", security: [{ bearerAuth: [] }] },
        post: { summary: "Create a webhook endpoint", security: [{ bearerAuth: [] }] },
      },
      "/v1/webhooks/{id}": { delete: { summary: "Disable a webhook endpoint", security: [{ bearerAuth: [] }] } },
    },
  };
}
