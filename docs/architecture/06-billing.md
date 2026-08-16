# Billing and API entitlements

Stripe is **planned, not connected**. Prices are not finalized.

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

Phase 04 implements **test** foundations. Live is Phase 23 with an explicit go-ahead.

## Separation

TCC memberships do not entitle this product. TCC as customer is a normal tenant.
