# Billing

Stripe is **planned, not connected**. No Stripe account objects, products, webhooks, or SDKs are created in Phase 00.

## Commercial model

Subscription + metered usage.

The tenant is the customer. Users inside a tenant are not billed individually.

## Planned plans

| Plan | Intent | Included |
|---|---|---|
| `free` | Evaluation | 1 tenant, 1 API key, low ingest and decision caps |
| `starter` | First paid | Higher caps, email support |
| `growth` | Operator use | Multiple keys, more members, longer retention |
| `scale` | First-party / high volume | Custom caps, priority support |

Exact prices are not locked in Phase 00. Plan keys are locked so implementation does not invent parallel catalogs.

## Meters

| Meter key | What it counts |
|---|---|
| `ingest.events` | Accepted source events |
| `decisions.generated` | New Decision Records, excluding supersede copies if marked internal |
| `api.reads` | Decision and entity read API calls |

Console page views are not billable in v1.

## Stripe objects (later)

When Phase 07 connects Stripe test mode:

- One Stripe Customer per tenant
- One Stripe Product per plan
- Recurring Price for the subscription
- Metered Prices or Billing Meters for usage
- Checkout for first subscribe
- Customer Portal for plan and payment method
- Webhooks: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`

Store only:

- `stripe_customer_id`
- `stripe_subscription_id`
- plan key and status
- period end

Do not store raw card numbers. Do not reuse TCG Card Central Stripe products, webhook endpoints, or customer IDs.

## Entitlement checks

`apps/api` checks `subscriptions.status` and plan caps before:

- accepting ingest over the free/paid cap
- creating additional API keys
- extending retention

Soft cap: return `402` or `429` with a machine-readable code. Do not silently drop events.

## Separation from other products

This platform bills **tenants** for decision intelligence. Users of TCG Card Central, or any other external system, are not entitled to this product by virtue of that other membership. If TCC later becomes a customer or reseller, it is a normal tenant (or a later reseller mapping), not a shared Stripe customer.

## Phase 00 constraint

No Stripe keys in this repo. No webhook handler code. No price IDs. Documentation only.
