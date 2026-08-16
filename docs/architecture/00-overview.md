# Architecture overview

Working name: **Intelligence Platform**  
Repository: `intelligence-saas-platform`  
Phase: **00 — architecture and documentation only**

## What this system is

Intelligence Platform is a **greenfield, independent, commercial multi-tenant decision intelligence SaaS**.

It ingests operational signals from connected systems, normalizes them into tenant-scoped entities and features, and produces **Decision Records**: scored, explainable recommendations with suggested actions and an audit trail.

The product is sold through its own auth, CRM, email, Stripe billing, and versioned APIs. It is designed for multiple industries. No other product’s stack is the foundation.

## What TCG Card Central is

TCG Card Central is **not** part of this platform. It has exactly three future roles:

1. An external integration
2. A potential authoritative provider of TCG card identity, set, language, pricing, price history, and related TCG market data through a **secure versioned API that TCC would expose**
3. One future consumer / customer of this SaaS’s intelligence APIs

TCG Card Central’s application, database, hosting, auth, email, and billing are out of scope and must not be reused.

## What this system is not

- Not a TCG Card Central feature, module, shared database, or shared runtime
- Not constrained by TCG Card Central’s framework, hosting, or vendor choices
- Not a scanner, marketplace, listing tool, or collection app
- Not a generic BI warehouse or dashboard builder
- Not a chatbot wrapper

## System sketch

```text
Humans                         Machines
  │                              │
  ▼                              ▼
apps/web (Next.js)            apps/api (Hono)
Vercel                        Railway
marketing · console · admin   /v1 commercial JSON API
  │                              │
  │                              ├── API keys, quotas, OpenAPI
  │                              ├── ingest / decisions / receipts
  │                              └── Stripe + connector webhooks
  │                              │
  └──────────────┬───────────────┘
                 │
                 ▼
        PostgreSQL (Neon) + RLS
        Better Auth · Drizzle
                 │
                 ▼
        apps/worker (BullMQ)
        Railway + Redis
        normalize · features · policies · decisions
                 │
        R2 artifacts · Resend email · Stripe billing
                 │
Later, not now:
  TCG Card Central ── external API provider and/or API customer
```

## Locked platform boundaries

| Concern | Owner | Relationship to TCG Card Central |
|---|---|---|
| Git repository | this repo | None |
| Product UI | Vercel / `apps/web` | None |
| Public API | Railway / `apps/api` | TCC may later call it as a customer |
| Intelligence jobs | Railway / `apps/worker` | None |
| Database / Auth | Neon + Better Auth | None. Do not use TCC’s database or auth |
| Billing | this product’s Stripe | None. Do not reuse TCC Stripe objects |
| Email / CRM | Resend + first-party CRM | None |
| TCG reference data | TCC’s future versioned API, if and when it exists | Optional outbound client in the TCG industry pack |
| Public domain | new hostname, TBD | Not `tcgcardcentral.com` |

## Core product objects

1. **Tenant** — paying organization
2. **Membership** — user role inside a tenant
3. **API key** — machine principal
4. **Connector** — authenticated source or sink
5. **Source Event** — immutable ingested signal
6. **Entity** — tenant-scoped business object
7. **Feature** — computed input to decisioning
8. **Policy** — versioned rules that produce or constrain decisions
9. **Decision Record** — the sellable output
10. **Action Receipt** — whether a decision was accepted, rejected, or acted on
11. **Usage Event** — metered billing input
12. **CRM account** — GTM record, optionally linked to a tenant
13. **Industry pack** — vertical connector and decision catalog

## Document map

| Document | Purpose |
|---|---|
| [01-product-scope.md](./01-product-scope.md) | Problem, users, in/out of scope |
| [02-system-architecture.md](./02-system-architecture.md) | Runtime, services, request paths |
| [03-multi-tenancy.md](./03-multi-tenancy.md) | Isolation model and roles |
| [04-logical-data-model.md](./04-logical-data-model.md) | Logical schema, not migrations |
| [05-auth-identity.md](./05-auth-identity.md) | Users, API keys, service auth |
| [06-billing.md](./06-billing.md) | Stripe plan, no live connection |
| [07-integrations.md](./07-integrations.md) | External systems, contracts only |
| [08-infrastructure.md](./08-infrastructure.md) | Hosting plan, no resources |
| [09-security.md](./09-security.md) | Threat model and controls |
| [10-api-contracts.md](./10-api-contracts.md) | Planned HTTP contracts |
| [11-phase-roadmap.md](./11-phase-roadmap.md) | Phase 01+ gates |
| [12-decisions-log.md](./12-decisions-log.md) | Locked decisions |
| [13-stack-selection.md](./13-stack-selection.md) | Independent stack rationale |
| [14-crm-and-gtm.md](./14-crm-and-gtm.md) | CRM and email |
| [15-industry-packs.md](./15-industry-packs.md) | Multi-industry expansion |

## Phase 00 rule

This folder is planning truth. It does not authorize scaffolding, migrations, cloud resources, Stripe, TCG Card Central, or production APIs.
