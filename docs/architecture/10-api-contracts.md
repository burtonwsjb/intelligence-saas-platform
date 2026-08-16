# API contracts

These are planned HTTP contracts. They are not implemented in Phase 00 and are not production APIs.

Served by `apps/api` (Hono).  
Base path: `/v1`  
Auth: `Authorization: Bearer <api_key>` unless noted  
OpenAPI 3.1 will be published at `/v1/openapi.json` when the API is implemented.

Kernel ingest routes below remain. **Customer-facing intelligence products** are specified conceptually in [27-commercial-api-and-webhooks.md](./27-commercial-api-and-webhooks.md) (`cards`, `printings`, `sets`, `prices`, `market-history`, `signals`, `creators`, `creator-calls`, `indices`, `predictions`, `opportunities`, `content`). URLs are not finalized.

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
| 429 | Rate or quota |
| 202 | Event accepted for processing |

## `POST /v1/events`

Scope: `ingest:write`

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
