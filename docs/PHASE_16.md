# Phase 16 — Commercial API, webhooks, usage metering, and customer intelligence delivery

Status: **implemented**. Phase 17 has **not** started.

The intelligence system is exposed through tenant-authenticated `/v1` contracts. No production infrastructure is deployed. Stripe is not called on the request path. Predictions remain shadow-mode and are not published on the customer endpoint.

## Domain boundary

| Location | Role |
|---|---|
| `apps/api/src/commercial.ts` | Commercial routes and response contracts |
| `apps/api/src/openapi.ts` | `/v1/openapi.json` (no internal/secret routes) |
| `packages/db/src/schema/webhook.ts` | Tenant `webhook_endpoint` / `webhook_delivery` |
| `packages/db/drizzle/0016_phase16_webhooks.sql` | RLS-backed webhook tables |
| `packages/db/src/webhooks/` | SSRF checks, HMAC signing, retry/delivery |
| `packages/contracts/src/commercial.ts` | Event and meter catalogs |

## Auth, scopes, entitlements

Bearer API keys (Phase 04) are required. Issuable scopes now include the commercial read scopes whose routes exist, plus `webhooks:manage`. `content:read` remains known but not issuable.

Entitlements (DB resolver, no Stripe):

- Monthly `api.reads` quota → `api_requests_per_month` (429)
- `history_depth_days` clips market history
- `predictions` required before the prediction route, which then returns `prediction_not_published`
- `creator_analytics` gates creator reads (402)
- `webhooks` gates webhook management (402)

Usage meters `api.reads`, `prices.read`, `market_history.read`, `opportunity.read`, `creator.read`, and `prediction.read` are recorded once per request id.

## Exact printing identity

TCG responses include `game`, `card`, `set`, `collector_number`, `language`, and `variant`. Languages are never merged. Filters are an allow-list (`game`, `set`, `language`, `variant`, `source`, `condition`, `grade`, `from`, `to`, `cursor`, `limit`).

Cursor pagination is `cursor.v1` (stable id, limit 1–100).

## Webhooks

Tenant-owned HTTPS/HTTP URLs. Signing secret shown once, stored encrypted. HMAC `v1=` over `{timestamp}.{body}` (`X-ISP-Signature`, `X-ISP-Timestamp`). Event id is stable per endpoint (`webhook_delivery_event_uidx`). Retries use `exp_backoff.v1` with dead-letter after 8 attempts. Endpoints disable after 8 consecutive failures. Response bodies are truncated to 200 characters.

SSRF: reject localhost, loopback IPv4/IPv6, RFC1918, link-local, metadata hosts, non-http(s), and userinfo. Delivery tests use an injected fetch and public-IP DNS fixture — no arbitrary external hosts.

Supported events (from actual system state; not `prediction.created` while shadow): `card.trending`, `card.buy_signal`, `card.sell_signal`, `creator.call_detected`, `creator.consensus_changed`, `market.breakout`, `opportunity.changed`, `index.moved`, `usage.warning`.

## Errors

`{ error: { code, message, request_id } }`. No SQL or stack traces.

## Phase 17 boundary

Do not implement CRM, email lifecycle, or billing Checkout/Portal completion.
