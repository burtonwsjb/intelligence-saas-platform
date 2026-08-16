# Product scope

## Problem

Operational systems already collect the data needed to make better decisions: what to price, restock, allocate, investigate, or ignore. Those systems are built to **run one business**, not to sell durable, explainable decisions as a multi-tenant product.

This platform exists so any tenant, in any industry, can send signals in and get Decision Records out — with isolation, billing, audit, and APIs that can be commercialized.

## Solution

An independent SaaS that:

1. Signs up tenants and bills them on Stripe
2. Accepts events through a versioned public API
3. Computes tenant-scoped features
4. Evaluates versioned policies
5. Emits Decision Records with rationale
6. Records accept / reject / action feedback
7. Gives operators a console, CRM, and email loop

Industry systems are integrations, not the product kernel.

## Users

| Actor | Job |
|---|---|
| Tenant owner | Creates the workspace, manages billing, owns API keys |
| Tenant admin | Manages members, connectors, and policies |
| Analyst | Reviews decisions, tunes policies, inspects features |
| Viewer | Read-only decision and metric access |
| API customer | Machine principal that posts events and reads decisions |
| Platform operator | Plans, CRM, abuse, pack catalog |

End users of an integrated system (for example TCG Card Central shoppers) are **not** users of this platform unless a later product decision exposes a consumer surface.

## Jobs to be done

- “Show me the next best action for this entity, with a reason.”
- “Tell me which records need attention today.”
- “Apply the same policy consistently.”
- “Prove why a recommendation was made.”
- “Learn whether operators accepted or ignored the recommendation.”
- “Meter and bill API usage.”

## In scope for the product

- Multi-tenant auth, membership, and Postgres RLS
- Commercial versioned APIs and hashed API keys
- Connector registration and inbound event ingest
- Entity resolution by `(tenant_id, entity_type, external_id)`
- Feature computation and policy evaluation
- Decision Records, suggested actions, and receipts
- Tenant console
- Platform admin, first-party CRM, and Resend email
- Stripe subscriptions and metered usage
- Audit log
- Industry packs, with TCG as one optional later pack
- Contract for TCG Card Central as a future external provider and/or API customer

## Out of scope

- TCG scanning, OCR, camera capture, marketplace, eBay listing, shipping
- Collection folders or consumer portfolio UX
- Writing into TCG Card Central’s database
- Reusing TCG Card Central’s stack, hosting, auth, email, or Stripe catalog
- Training or hosting foundation models in v1
- Cross-tenant data pooling without an explicit, consented product
- Custom tenant-owned SQL / warehouse access in v1

## Generic model, optional TCG mapping

The platform does not create TCG-only tables. If a TCG tenant appears later, mapping is pack-level:

| External TCG concept | Platform type |
|---|---|
| Card / SKU | `entity_type = sku` |
| Inventory / collection item | `entity_type = inventory_item` |
| Listing | `entity_type = listing` |
| Location / shop | `entity_type = location` |
| Price snapshot | `metric_key = price.usd` |
| Suggested list price | `decision_type = price.recommend` |
| Buy / hold / sell | `decision_type = position.action` |
| Restock priority | `decision_type = restock.priority` |
| Identification or anomaly risk | `decision_type = risk.flag` |

The same entity and decision types can be used by a non-TCG tenant.

## Success criteria for v1

A tenant can:

1. Sign up and create one tenant
2. Authenticate users and issue an API key
3. Ingest events through the documented contract
4. See entities and Decision Records in the console
5. Accept or reject a decision
6. Subscribe to a paid plan in Stripe test mode

TCG Card Central is **not** required for v1 success.

## Non-goals for Phase 00

Phase 00 does not name a public brand, pick a production domain, create cloud resources, or implement any of the above.
