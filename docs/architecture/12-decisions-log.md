# Architecture decisions

Locked in Phase 00. Change only with an explicit new decision, not during implementation.

| ID | Decision | Choice | Why |
|---|---|---|---|
| D01 | Product type | Independent commercial multi-tenant decision intelligence SaaS | Greenfield product, not a module of another app |
| D02 | TCG Card Central | External integration only: future provider API and/or API customer | Not a stack, database, or design constraint |
| D03 | Tenancy | Shared schema + `tenant_id` + Postgres RLS | Enforceable isolation without per-tenant databases |
| D04 | Language | TypeScript | Shared contracts across web, API, and worker |
| D05 | Repo shape | pnpm + Turborepo; `web` / `api` / `worker` | API commercialization and intelligence jobs are first-class |
| D06 | Console | Next.js App Router | Commercial SaaS UI standard |
| D07 | Public API | Hono + Zod OpenAPI | Versioned, documented, always-on API product |
| D08 | Worker | BullMQ + Redis | Intelligence workloads, retries, rate limits |
| D09 | Database | Neon Postgres + Drizzle | Independent Postgres, branching, RLS, write-path fit |
| D10 | Auth | Better Auth organizations | B2B tenants without inheriting another product’s auth |
| D11 | Machine auth | Hashed API keys | Commercial API customers |
| D12 | Objects | Cloudflare R2 | Cheap artifacts |
| D13 | Email | Resend | Transactional and GTM mail owned by this product |
| D14 | CRM | First-party objects, later optional sync | Commercial GTM without Salesforce in v1 |
| D15 | Billing | Stripe subscriptions + meters | Tenant is the customer |
| D16 | Hosting | Vercel (web) + Railway (api, worker) | Fit each runtime; no shared host with other products |
| D17 | Decision engine v1 | Deterministic policies, not LLM | Explainable, cheaper, safer |
| D18 | Source of truth | External systems keep operational data; this platform keeps events, features, decisions | Avoid cloning foreign catalogs |
| D19 | Industry expansion | Packs, not core-schema forks | Multi-industry without becoming a TCG kernel |
| D20 | Cross-tenant learning | Forbidden in v1 | Isolation and consent |

## Superseded Phase 00 decisions

The first Phase 00 pass locked TanStack Start, Supabase, and a TCC-similar stack. That is **void**. Those choices were constraints from TCG Card Central and are not authorized.

## Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Build inside TCG Card Central | Cannot sell or isolate an independent SaaS |
| Reuse TCC stack (TanStack Start, TCC Supabase, TCC Railway, Lovable) | Explicitly forbidden; wrong foundation |
| Share any TCC database or Stripe catalog | Security and product coupling |
| Next.js-only public API | Weak API product, request limits |
| NestJS | Heavier than needed for a founding team |
| Database-per-tenant | Ops cost too high for v1 |
| LLM-first engine | Cost, opacity, prompt-injection |
| Direct SQL access to TCC | Breaks independence |

## Open items (not blockers for Phase 01)

- Public brand name
- Production domains
- Exact plan prices
- Redis vendor
- Whether TCC will ship a versioned reference API, and when
- Whether TCC will display Decision Records in its own UI (TCC’s decision, not this repo)
- CRM sync target later
