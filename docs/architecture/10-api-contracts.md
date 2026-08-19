# API contracts

Phase 05 implements generic `POST /v1/events`. Phase 06 adds shared kernel contracts in `@isp/contracts` (`entity`, observation, metric, signal, feature snapshot, decision record) and a v1 generic event registry. Commercial intelligence routes are not implemented.

Served by `apps/api` (Hono).  
Base path: `/v1`  
Auth: `Authorization: Bearer <api_key>` unless noted  
OpenAPI 3.1 will be published at `/v1/openapi.json` when the API is implemented.

Kernel ingest routes below remain. Historical kernel queries are repository-only (no public `/v1/entities` yet). Entity resolution in Phase 10 is a worker/library API (`resolver.v1`), not a public route. **Customer-facing intelligence products** are specified conceptually in [27-commercial-api-and-webhooks.md](./27-commercial-api-and-webhooks.md) (`cards`, `printings`, `sets`, `prices`, `market-history`, `signals`, `creators`, `creator-calls`, `indices`, `predictions`, `opportunities`, `content`). URLs are not finalized.

## Common error shape

```json
{
  "error": {
    "code": "tenant_suspended",
    "message": "Tenant is suspended."
  }
}
```

| HTTP | Meaning |
|---|---|
| 400 | Validation |
| 401 | Missing/invalid credentials |
| 403 | Scope or role denied |
| 402 | Plan entitlement |
| 404 | Unknown resource in this tenant |
| 409 | Idempotency conflict with different payload |
| 429 | Rate or quota (`quota_exceeded` for monthly plan limits) |
| 202 | Event accepted for processing |

## `POST /v1/events`

Implemented in Phase 05. Scope: `ingest:write`. Tenant is the API key organization. Max body **65536** bytes (`413 payload_too_large`). Requires `idempotency_key`. Same key + same body returns the original `202`. Same key + different body returns `409 idempotency_conflict`. Optional `x-request-id` is echoed when well-formed; it is not an idempotency key.

v1 generic `event_type` registry (unknown types return `400`): `metric.snapshot`, `pricing.snapshot`, `transaction.summary`, `inventory.snapshot`, `sentiment.snapshot`, `ranking.snapshot`. `pricing.snapshot` is preserved as a generic metric event and normalizes to observation type `metric.snapshot`. TCG pack event types (`tcg.market.sold`, `tcg.market.listing_snapshot`, `tcg.market.reference_price`, `tcg.market.volume_snapshot`) and source pack types (`source.content.ingested`, `source.engagement.snapshot`) are **not** accepted on this route.

```json
{
  "event_type": "pricing.snapshot",
  "occurred_at": "2026-08-16T00:00:00.000Z",
  "idempotency_key": "src:price:sku_123:2026-08-16T00:00:00Z",
  "entity": {
    "type": "sku",
    "external_id": "sku_123",
    "display_name": "Example SKU",
    "attributes": { "category": "example" }
  },
  "metrics": [
    { "key": "price.usd", "value": 12.34, "unit": "usd" }
  ],
  "payload": { "source": "generic_http" }
}
```

Response `202`:

```json
{
  "event_id": "uuid",
  "accepted": true
}
```

## `GET /v1/decisions`

Scope: `decisions:read`

Query: `status`, `decision_type`, `entity_id`, `cursor`, `limit`

```json
{
  "data": [
    {
      "id": "uuid",
      "decision_type": "price.recommend",
      "status": "proposed",
      "subject_entity_id": "uuid",
      "confidence": 0.81,
      "recommendation": { "action": "list", "price_usd": 14.5 },
      "rationale": [{ "code": "above_cost", "message": "Price exceeds last cost." }],
      "created_at": "2026-08-16T00:05:00.000Z",
      "expires_at": null
    }
  ],
  "next_cursor": null
}
```

## `GET /v1/decisions/:id`

Scope: `decisions:read`

Returns one Decision Record plus suggested actions and receipts.

## `POST /v1/decisions/:id/receipts`

Scope: `receipts:write`

```json
{
  "result": "accepted",
  "action_key": "apply_price",
  "note": "Applied in source system"
}
```

## `GET /v1/entities/:id`

Scope: `decisions:read`

Entity, current features, recent decisions.

## Browser-only routes later

Not the commercial API:

- `apps/web` `/app/*` tenant console
- `apps/web` `/admin/*` platform admin and CRM
- `apps/web` `/auth/*` Better Auth
- `apps/api` `/webhooks/stripe` Stripe signature required

## Versioning

v1 is additive. Breaking changes require `/v2`. Clients must send `idempotency_key` on ingest forever. Rate limits and quota codes are part of the product.

## Out of scope here

- GraphQL
- Public unauthenticated intelligence APIs
- Implementing TCG Card Central’s own API
- Finalizing every commercial URL in Phase 00
