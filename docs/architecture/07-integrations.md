# Integrations

All integrations are **contracts only** in Phase 00. Nothing is connected. TCG Card Central is not modified.

## Integration law

1. This platform never opens another product’s database.
2. This platform never deploys into another product’s host.
3. This platform never reuses another product’s Stripe, auth, or email objects.
4. External systems never write directly to this database.
5. The only coupling is HTTPS + credentials + versioned contracts.
6. TCG Card Central’s stack is irrelevant to this platform’s stack.

## Connector model

A connector is a tenant-owned instance of a platform `connector_definitions.type`.

v1 types:

| Type | Direction | Phase that may implement |
|---|---|---|
| `generic_http` | inbound events from any API customer | 04 |
| `tcg_card_central` | later; see below | 08 sandbox, 10 production |

## Generic HTTP ingest

Any customer posts a source event to `/v1/events` with an API key.

Required fields:

- `event_type`
- `occurred_at`
- `idempotency_key`
- `payload`
- optional `entity` `{ type, external_id, display_name, attributes }`
- optional `metrics[]`

This is enough to build and sell the product without TCG Card Central.

## TCG Card Central — future external system only

Inspected only to understand what data it already holds and what a future API would need. Not a foundation.

TCG Card Central already holds, in its own product:

- Card identity (game, set, collector number, language, finish)
- Catalog metadata
- Current prices and price history
- Operational objects this platform must **not** clone as source of truth (scans, collections, listings, vendors)

Those facts inform a **future TCC-owned versioned API**, which TCC would have to expose. This repo does not build that API and does not modify TCC.

### Role 1 — external integration

Signed HTTPS only. No shared schema, no shared runtime.

### Role 2 — potential authoritative TCG reference provider

If TCC exposes a secure versioned API, this platform’s TCG industry pack may call it as an outbound client to resolve:

| Resource (conceptual) | Why a tenant might need it |
|---|---|
| Card identity | Canonical game / set / language / finish / identifier |
| Set metadata | Set membership and print context |
| Current price | Feature input for `price.recommend` |
| Price history | Feature input for movement and risk |
| Related market facts | Only what the published TCC API documents |

This platform caches **derived features**, not a full shadow catalog, unless a later phase explicitly decides a bounded cache.

Planned client shape (not implemented):

```text
GET {TCC_API_BASE}/v1/cards/{id}
GET {TCC_API_BASE}/v1/cards?game=&set=&number=&language=
GET {TCC_API_BASE}/v1/cards/{id}/price
GET {TCC_API_BASE}/v1/cards/{id}/price-history
```

Auth: bearer token or HMAC issued by TCC to this platform’s connector, stored in this platform’s secret store. Timeouts, retries, and circuit breaking live on the worker. No request-path fetch from `apps/web`.

If TCC never ships that API, the TCG pack can still work from customer-supplied ingest events.

### Role 3 — one future API customer

TCC may become a tenant of this SaaS and call:

- `POST /v1/events`
- `GET /v1/decisions`
- `POST /v1/decisions/:id/receipts`

TCC would use a normal tenant API key. Displaying Decision Records inside TCC is a TCC change, not work in this repo.

### Mapping rules

- Foreign ids become `entities.external_id`
- Foreign table names do not become platform table names
- Send only decision-relevant fields
- Do not clone TCC `card_intelligence` or operational tables

### Sandbox before production

Phase 08 uses fixtures or a TCC **staging** API if one exists. Phase 10 is the first production TCC connection and requires an explicit go-ahead.

## Stripe

See [06-billing.md](./06-billing.md). Connected in Phase 07 test mode only.

## Email

See [14-crm-and-gtm.md](./14-crm-and-gtm.md). Resend only.

## Forbidden in early phases

- Any TCG Card Central database or service-role access
- TCGPlayer, eBay, or other market-source connections unless a later pack defines them
- Embedding this app inside another product’s host
