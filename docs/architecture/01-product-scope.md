# Product scope

## Problem

Collectible markets move on thin books, language-split printings, creator calls, and social hype that often does not match transactions. Operators need explainable intelligence — not a single score and not a blog farm.

The same kernel should later serve other industries. The first product that must be complete is **TCG market intelligence**.

## Two layers

### Core platform (industry-independent)

- Multi-tenancy, auth, RBAC, RLS
- Stripe billing, entitlements, API keys, metering
- CRM and email
- Versioned API platform and customer webhooks
- Ingestion, entity resolution
- Observations, signals, scoring, predictions
- Content intelligence pipeline

### First commercial vertical

- TCG / trading-card market intelligence
- Canonical printing identity and first-class language
- Market history and collectible-adapted analytics
- YouTube / Reddit / social sources
- Creator calls, contextual authority, trust states
- Indices, alpha, opportunity, buy/hold/sell
- Accountable predictions
- TCG dashboard, commercial TCG API, SEO/content

Generic HTTP ingest stays available. It is not the v1 commercial offering. **v1 success requires the TCG vertical**, not merely generic events.

## Users

| Actor | Job |
|---|---|
| Tenant owner / admin | Billing, keys, members, webhooks |
| Analyst | Reads TCG intelligence, creators, predictions |
| API customer | Machines consuming commercial intelligence |
| Platform operator | CRM, packs, creator trust, index specs, abuse |
| Creator (data subject) | Appears in profiles because public calls were extracted |

TCG Card Central shoppers are not users of this platform unless they become tenants.

## In scope

Everything in the core list and the TCG vertical list above, as architecture. Implementation follows the revised roadmap.

## Out of scope

- Building inside TCG Card Central
- Reusing TCC stack, DB, auth, Stripe, or email
- TCC scanner / marketplace / collection UX
- Silently merging language books
- Ranking creators on raw 4/4 accuracy
- Social-only buy signals
- Unvalidated embedding “models”
- Final prices or final URL paths

## Success (commercial v1)

A TCG tenant (or the first-party TCG surface) can use exact-printing market history, resolved creator calls, contextual authority, indices, opportunity scores with explainability, accountable predictions, and the commercial API/webhooks — on this platform’s own tenancy and billing.

TCG Card Central production connection is still a later integration phase, not a substitute for the vertical.
