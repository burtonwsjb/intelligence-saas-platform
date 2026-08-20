# Billing and API entitlements

Stripe **test-mode foundation is implemented** (see [PHASE_04.md](../PHASE_04.md)). Phase 17 completed the application-side billing lifecycle: trial window, past-due/canceled retention, plan TBD pricing display, and a local Checkout/Portal adapter that still fails closed. Local development uses **billing simulation** (no Stripe network). Hosted Checkout/Portal remain deferred. Dollar prices are not finalized. Live Stripe is forbidden until a later explicit go-ahead.

## Model

Subscription + usage-based API monetization. The tenant is the customer.

Plan keys remain `free` · `starter` · `growth` · `scale` (names only).

## Entitlements (eventual)

A plan may gate:

- API requests
- API keys
- team members
- projects / workspaces
- history depth
- predictions
- creator analytics
- content generation
- alerts
- webhooks
- exports
- premium datasets

Soft cap: `402` / `429` with a machine-readable code. Do not silently drop work.

## Meters (planned)

| Meter key | Counts |
|---|---|
| `api.requests` | Commercial API calls |
| `ingest.events` | Accepted ingest |
| `predictions.issued` | Platform predictions |
| `webhooks.delivered` | Successful deliveries |
| `content.generated` | Approved generations |
| `exports.bytes` | Export volume |

Console page views are not billable.

## Stripe objects (later)

Customer, products, recurring + metered prices, Checkout, Portal, Billing Meters, standard subscription webhooks.

Store customer id, subscription id, plan key, status, period end. Never card PAN. Never TCC Stripe objects.

Phase 04 implemented **test** foundations: normalized `tenant_billing`, data-driven plans, signed webhooks, fail-closed Checkout/Portal server actions, local billing simulation, and internal usage/quota stubs. Stripe Billing Meters are **not** wired. Hosted Checkout/Portal against Stripe test products are deferred. Live is Phase 23 with an explicit go-ahead.

## Separation

TCC memberships do not entitle this product. TCC as customer is a normal tenant.
