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
      "/v1/printings/{id}/prices": { get: { summary: "Latest sold price", security: [{ bearerAuth: [] }] } },
      "/v1/printings/{id}/market-history": { get: { summary: "Sold and listing history", security: [{ bearerAuth: [] }] } },
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
