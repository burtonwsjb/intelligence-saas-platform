# Commercial API products and webhooks

Phase 16 implements tenant-authenticated `/v1` commercial routes, signed webhooks, SSRF defense, usage metering, and `/v1/openapi.json`. See [PHASE_16.md](../PHASE_16.md). URLs below are the v1 contract; additional aliases may be added later. Versioning stays `/v1`. Auth stays hashed API keys, scopes, metering, and quotas.

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

Phase 07 does **not** open commercial `cards` / `printings` / `prices` / `markets` endpoints. Phase 16 does.

Commercial scopes (implemented):

- `cards:read`
- `prices:read`
- `markets:read`
- `signals:read`
- `creators:read`
- `predictions:read` (route exists; customer payload stays unpublished while shadow)
- `opportunities:read`
- `webhooks:manage`

`content:read` and `holdings:read` remain reserved.

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

Webhook delivery uses HMAC signatures, bounded retries, and SSRF URL validation. Delivery tests inject a fetch fixture and must not contact arbitrary external hosts.

## What Phase 00 does not do

Historical planning note: Phase 00 did not implement routes. Phase 16 does.
