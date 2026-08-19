# Commercial API products and webhooks

Internal ingest (`/v1/events`) and generic decision records remain useful. They are **not** the customer-facing intelligence product.

URLs are conceptual. Do not treat them as final routes. Versioning stays `/v1`. Auth stays hashed API keys, scopes, metering, and quotas.

## Commercial domains

| Domain | Intent |
|---|---|
| `cards` | Card concepts |
| `printings` | Exact printings (language, variant, finish) |
| `sets` | Set metadata and set-level series |
| `prices` | Current prints |
| `market-history` | Bars and derived series |
| `markets` | Cohorts, games, languages |
| `signals` | Derived conditions |
| `creators` | Profiles and authority slices |
| `creator-calls` | Immutable calls and outcomes |
| `indices` | Specs, constituents, levels |
| `predictions` | Issued forecasts and outcomes |
| `opportunities` | Component scores + recommendation |
| `content` | Evidence-backed content products |

Generic `/v1/events`, `/v1/decisions`, `/v1/entities` remain for kernel/integration use and may stay scoped separately (`ingest:write`, `decisions:read`).

Phase 07 does **not** open commercial `cards` / `printings` / `prices` / `markets` endpoints. Customer API expansion is Phase 16.

Commercial scopes (planned, not final):

- `market:read`
- `creators:read`
- `predictions:read`
- `opportunities:read`
- `content:read`
- `webhooks:write`
- `holdings:read` (tenant-private)

## Entitlements that gate the API

See [06-billing.md](./06-billing.md). Meters and plan flags may limit requests, history depth, predictions, creator analytics, content, alerts, webhooks, exports, and premium datasets.

## Customer webhooks

Event names (eventual):

- `card.trending`
- `card.buy_signal`
- `card.sell_signal`
- `creator.call_detected`
- `creator.consensus_changed`
- `market.breakout`
- `prediction.created`
- `prediction.changed`
- `opportunity.changed`
- `index.moved`
- `usage.warning`

### Delivery design

| Control | Rule |
|---|---|
| Signing | HMAC of body + timestamp (`X-ISP-Signature`) |
| Retry | Exponential backoff, bounded |
| Idempotency | Stable `event_id`; receivers should key on it |
| Delivery log | Attempt, status, latency, response code |
| Disable | Auto-disable after repeated failures; tenant can rotate secrets |
| Filtering | Tenant subscribes by event type and optional entity filters |
| Privacy | No other tenant’s holdings; public/licensed market only unless the event is for that tenant |

Webhook delivery is a BullMQ job. Payloads cite the same evidence ids as the API.

## What Phase 00 does not do

No routes implemented. No public OpenAPI file in a running service. Contracts here plus [10-api-contracts.md](./10-api-contracts.md) are planning only.
