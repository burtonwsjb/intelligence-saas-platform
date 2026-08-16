# Architecture overview

Working name: **Intelligence Platform**  
Repository: `intelligence-saas-platform`  
Phase: **00 — architecture and documentation only**  
Review: **PASS WITH CHANGES** (corrective pass)

## What this system is

Intelligence Platform is a **greenfield, independent, commercial multi-tenant decision intelligence SaaS**.

The **core kernel** is industry-independent: tenancy, auth, billing, CRM, email, APIs, metering, webhooks, ingestion, entity resolution, observations, signals, scoring, predictions, and content intelligence.

The **first commercial vertical** is **TCG / trading-card market intelligence**. TCG is not an optional distant pack. It is the first complete implementation that proves the kernel. Generic HTTP ingest remains a reusable platform capability; it is not the primary product we are initially building.

## What TCG Card Central is

TCG Card Central is **not** part of this platform. It has exactly three roles:

1. An external integration
2. A potential authoritative provider of TCG card identity, set, language, pricing, price history, and related TCG market data through a **secure versioned API that TCC would expose**
3. One future consumer / customer of this SaaS’s intelligence APIs

TCC’s application, database, hosting, auth, email, and billing must not be reused. The TCG **vertical** lives in this repo; the TCC **product** does not.

## What this system is not

- Not a TCG Card Central feature, module, shared database, or shared runtime
- Not constrained by TCG Card Central’s stack
- Not a scanner, marketplace, listing tool, or collection app
- Not a generic HTTP ingest toy as the v1 commercial offering
- Not a generic AI blog spammer
- Not an equity-trading clone pasted onto cards

## System sketch

```text
Sources (market APIs, YouTube, Reddit, generic HTTP, later TCC API)
        │
        ▼
 apps/api (Hono)  +  apps/worker (BullMQ)
 ingest · resolve · observe · signal · score · predict · content
        │
        ▼
 Neon Postgres + Redis + R2
        │
        ├── apps/web  console · TCG dashboard · SEO · admin · CRM
        ├── commercial /v1 intelligence API
        ├── customer webhooks
        ├── Resend · Stripe
        └── later: TCC as provider and/or API customer
```

## Platform boundaries

| Concern | Owner | TCG Card Central |
|---|---|---|
| Kernel + TCG vertical | this repo | None |
| Product UI | Vercel / `apps/web` | None |
| Public API / webhooks | Railway / `apps/api` | May later call as a customer |
| Intelligence jobs | Railway / `apps/worker` | None |
| Database / Auth | Neon + Better Auth (provisional) | Never TCC’s project |
| Billing / email / CRM | Stripe + Resend + first-party CRM | None |
| TCG reference data | This platform’s identity model; TCC API as optional provider | External only |
| Domain | TBD | Not `tcgcardcentral.com` |

## Document map

| Document | Purpose |
|---|---|
| [01-product-scope.md](./01-product-scope.md) | Scope and first vertical |
| [02-system-architecture.md](./02-system-architecture.md) | Runtimes |
| [03-multi-tenancy.md](./03-multi-tenancy.md) | Isolation |
| [04-logical-data-model.md](./04-logical-data-model.md) | Logical schema |
| [05-auth-identity.md](./05-auth-identity.md) | Auth and API keys |
| [06-billing.md](./06-billing.md) | Stripe and entitlements |
| [07-integrations.md](./07-integrations.md) | TCC, sources |
| [08-infrastructure.md](./08-infrastructure.md) | Hosting plan |
| [09-security.md](./09-security.md) | Threat model |
| [10-api-contracts.md](./10-api-contracts.md) | Kernel + commercial API |
| [11-phase-roadmap.md](./11-phase-roadmap.md) | Phases 00–23 |
| [12-decisions-log.md](./12-decisions-log.md) | Decisions |
| [13-stack-selection.md](./13-stack-selection.md) | Provisional stack |
| [14-crm-and-gtm.md](./14-crm-and-gtm.md) | CRM and email |
| [15-industry-packs.md](./15-industry-packs.md) | Kernel vs first vertical |
| [16-core-intelligence-kernel.md](./16-core-intelligence-kernel.md) | Observations → content |
| [17-tcg-canonical-identity.md](./17-tcg-canonical-identity.md) | Printing identity and language |
| [18-tcg-market-intelligence.md](./18-tcg-market-intelligence.md) | Market data and analytics |
| [19-entity-resolution.md](./19-entity-resolution.md) | Mention → printing |
| [20-source-intelligence.md](./20-source-intelligence.md) | YouTube, Reddit, social |
| [21-creator-intelligence.md](./21-creator-intelligence.md) | Calls, authority, trust |
| [22-market-indices-and-alpha.md](./22-market-indices-and-alpha.md) | Indices and benchmarks |
| [23-opportunity-and-recommendations.md](./23-opportunity-and-recommendations.md) | Scores and buy/hold/sell |
| [24-prediction-engine.md](./24-prediction-engine.md) | Forecasts and accountability |
| [25-historical-analytics.md](./25-historical-analytics.md) | Time series and similarity path |
| [26-content-seo-intelligence.md](./26-content-seo-intelligence.md) | Evidence-driven content |
| [27-commercial-api-and-webhooks.md](./27-commercial-api-and-webhooks.md) | Customer API products |
| [28-neon-vs-supabase.md](./28-neon-vs-supabase.md) | Phase 02 vendor gate |

## Phase 00 rule

Documentation only. No scaffold, migrations, cloud, Stripe, or TCG Card Central work.
