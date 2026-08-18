# Phase roadmap

Do not start a later phase until the user explicitly says to begin that phase.

TCG is the first commercial vertical. Generic platform work comes first only as **foundation**, then TCG is implemented completely. Generic HTTP ingest must not postpone TCG indefinitely.

## Phase 00 — Architecture

Status: **corrective pass complete (documentation only)**

Allowed: documentation  
Forbidden: scaffold, migrations, cloud, Stripe, TCC, production APIs

## Phase 01 — Local monorepo / application shell

Status: **complete**

See [PHASE_01.md](../PHASE_01.md) for commands and layout.

- pnpm + Turborepo
- `apps/web` Next.js chrome
- Stub `apps/api` and `apps/worker`
- `.env.example` names only
- No cloud, no Stripe, no TCC, no real intelligence APIs

Exit: local web chrome runs.

## Phase 02 — Database / auth / tenant foundation

Status: **complete locally** (see [PHASE_02.md](../PHASE_02.md)). Cloud Neon is not provisioned yet.

- GitHub Actions CI (validate only)
- `packages/db` (Drizzle schema, migrations, RLS helper)
- `packages/auth` (Better Auth + organizations)
- Signup, email verification architecture, login, logout, session
- Initial organization/tenant with owner membership
- Protected `/app` with server-resolved active organization
- No TCC, no Stripe live, no TCG market ingest, no Phase 03 isolation test suite

Exit: sign-in can create one tenant. Phase 03 has **not** started.

## Phase 03 — RLS, RBAC, and security foundation

Status: **not started**

- RLS on tenant tables with a non-superuser role
- Roles, audit log
- Isolation tests

Exit: tenant hop tests fail closed.

## Phase 04 — Stripe / entitlements / API key foundations

- Stripe **test** mode
- Plan entitlements catalog (no final prices)
- Hashed API keys
- Meter stubs

Exit: test subscribe + key issue. (Moved earlier than the old Phase 07 so API monetization exists before TCG data scale.)

## Phase 05 — Queue, worker, and ingestion foundations

- Redis + BullMQ
- Generic `/v1/events` ingest
- `source_documents` / jobs
- Generic HTTP remains available here as a capability

Exit: an event becomes a stored observation job.

## Phase 06 — Core observation / signal / entity model

- Kernel entities, observations, signals
- Resolution **framework** (statuses, evidence) without TCG printing keys yet
- Score snapshot shape

Exit: fixture events produce observations and signals.

## Phase 07 — TCG canonical identity and TCG Card Central sandbox contract

- Printing / concept / variant / grade layers
- First-class language codes
- Provider alias map
- TCC **sandbox** contract only (fixtures or TCC staging API if it exists)
- Do not modify the TCC repo

Exit: exact printing keys exist; sandbox mapping tests pass.

## Phase 08 — TCG market-history ingestion

- Price, sales, volume, listings, spread, liquidity series
- Daily bars, quality flags
- No silent cross-language merge

Exit: a printing has a durable history.

## Phase 09 — YouTube / Reddit / source ingestion

- Source documents, lawful extracts
- Mentions without silent printing binds

Exit: sources land as documents + mention spans.

## Phase 10 — Entity resolution

- TCG resolver plugin
- exact / high_confidence / probable / ambiguous / unresolved
- Persist evidence

Exit: “Greninja 214” vs “Japanese Greninja” do not collapse.

## Phase 11 — Creator call extraction

- Immutable calls
- Extraction + resolution confidence
- Price and market snapshot at call

Exit: a fixture video/post becomes a call row.

## Phase 12 — Creator authority and outcome tracking

- Contextual slices
- Bayesian / Wilson sample-size handling
- Trust states
- Horizon outcomes + alpha

Exit: 4/4 does not outrank 730/1000 on raw rate.

## Phase 13 — Market analytics and indices

- Collectible-adapted analytics
- Generalized index spec, survivorship-safe history
- Benchmark selection

Exit: an index reconstructs historically.

## Phase 14 — Opportunity scoring

- Separate opportunity / risk / confidence / liquidity / recommendation
- Explainability payloads
- Provisional weights, versioned

Exit: a printing emits an explained recommendation or `insufficient_data`.

## Phase 15 — Prediction engine and accountability

- Horizons 7/30/90/180/365
- Ranges, not false precision
- Immutable issues + later outcomes

Exit: a prediction can be scored after a fixture horizon.

## Phase 16 — Customer API / webhooks / usage metering

- Commercial domains (cards, printings, creators, indices, …)
- Signed webhooks, delivery logs
- Stripe meters wired to real usage

Exit: a test key reads an opportunity and receives a signed webhook.

## Phase 17 — CRM / email / billing completion

- Full CRM lifecycle states and activity timeline
- Transactional vs lifecycle mail
- Entitlement polish

Exit: trial → active → at-risk paths exist in test.

## Phase 18 — TCG customer dashboard

- Printings, history, creators, indices, opportunities, predictions
- Explainability UI

Exit: an analyst can use the TCG product in the browser.

## Phase 19 — Content / SEO intelligence

- Evidence packages, validation, approval
- Canonical URL rules, thin-page blockers

Exit: one evidence-backed card analysis can be approved.

## Phase 20 — Admin platform

- Creator trust, index specs, source health, break-glass audit

Exit: operators can exclude a creator without deleting history.

## Phase 21 — Staging / security / load testing

- Vercel + Railway + Neon staging
- RLS/security review, load on ingest and bars

Exit: staging is independently hosted (not on TCC infra).

## Phase 22 — Controlled beta

- Invited TCG tenants
- Stripe test or limited live per explicit go-ahead

Exit: beta checklist signed off.

## Phase 23 — Production

- Production hosts and Stripe live
- TCC **production** integration only with an explicit command

Exit: production TCG intelligence SaaS is live on this stack.

## Sequencing notes

- Stripe/keys (04) sit before heavy TCG ingest so entitlements exist when data gets expensive
- Identity (07) before market history (08) and resolution (10)
- Sources (09) before resolution (10) and calls (11)
- Accountability (15) before selling predictions on the API (16)
- Dashboard (18) after the intelligence objects exist
- CRM completion (17) after API metering so usage warnings are real; CRM **foundation** still starts in 02/04

## Stop rule

If a prompt is ambiguous, do not advance a phase. Ask or stop.
