# Phase roadmap

Do not start a later phase until the user explicitly says to begin that phase.

## Phase 00 — Architecture

Status: **complete (revised for independent stack)**

Allowed: documentation in this repository  
Forbidden: app scaffold, migrations, cloud resources, Stripe, TCG Card Central, production APIs

## Phase 01 — Local application shell

Allowed:

- pnpm + Turborepo monorepo
- `apps/web` Next.js chrome (marketing + empty console)
- Placeholder `apps/api` and `apps/worker` package stubs without real integrations
- `.env.example` with names only
- Unit test runner

Forbidden:

- Neon, Vercel, Railway, Redis cloud, R2, Resend projects
- Stripe
- TCG Card Central
- Real API implementations beyond a stub health route
- Production migrations

Exit: local web chrome runs. No cloud resources exist.

## Phase 02 — Auth and tenant foundation

Allowed:

- Local Postgres (Docker) or a **new** Neon dev project
- Better Auth magic link
- `users` / `profiles` / `tenants` / `memberships`
- Identity migrations only

Forbidden:

- TCG Card Central
- Stripe
- Production hosts
- Ingest/decision APIs

Exit: a user can sign in and own one tenant locally.

## Phase 03 — Data model and RLS

Allowed:

- Migrations for the logical model
- RLS policies
- Drizzle repositories

Forbidden:

- Production hosts
- Stripe live
- TCG Card Central

Exit: tenant isolation is proven with tests.

## Phase 04 — Commercial ingest API and jobs

Allowed:

- Hono `/v1/events`
- API keys
- Local Redis + BullMQ worker
- Entity upsert from events

Forbidden:

- TCG Card Central connector
- Stripe

Exit: generic HTTP ingest creates entities.

## Phase 05 — Decision engine v1

Allowed:

- Deterministic policy interpreter
- Feature snapshots
- Decision Records

Forbidden:

- LLM decisioning
- TCG Card Central
- Stripe live

Exit: a fixture event produces a Decision Record.

## Phase 06 — Tenant console and operator CRM

Allowed:

- Decisions, entities, members, API keys, usage views
- Accept/reject receipts
- First-party CRM screens for platform admin

Forbidden:

- TCG Card Central UI embedding
- Stripe live

Exit: an operator can review a decision; an admin can see a CRM account.

## Phase 07 — Stripe test mode and Resend

Allowed:

- Stripe test keys
- Checkout, portal, webhooks
- Entitlement caps
- Resend transactional mail

Forbidden:

- Stripe live
- TCG Card Central

Exit: a tenant can subscribe in test mode.

## Phase 08 — TCG Card Central sandbox contract

Allowed:

- Fixtures for TCC as API customer
- Optional client against a TCC **staging** versioned API if it exists
- Mapping tests in the TCG pack

Forbidden:

- TCC production database
- TCC production writes
- Any shared stack or hosting
- Modifying the TCG Card Central repository

Exit: sandbox events or fixture provider data produce decisions.

## Phase 09 — Staging harden and first controlled deploy

Allowed:

- Vercel staging for web
- Railway staging for API and worker
- Neon staging
- Redis, R2, Resend, Stripe test

Forbidden:

- TCC production connector
- Hosting this product on TCC infrastructure

Exit: staging URLs run this product independently.

## Phase 10 — TCG Card Central production integration

Allowed only after an explicit user command.

- TCC production as API customer and/or reference-data provider
- Still no shared database or stack

Forbidden until then: any production TCC connection.

## Stop rule

If a later prompt is ambiguous, do not continue to the next phase. Ask or stop.
