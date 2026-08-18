# Stack selection

This document chooses the technology stack **independently**. TCG Card Central’s stack is not a foundation, default, or constraint.

Selection criteria, in order of weight:

1. Security and tenant isolation
2. API commercialization
3. Multi-tenancy
4. Intelligence workload performance
5. Maintainability and developer experience
6. Scalability
7. Cost at early and growth stages
8. Stripe billing, email, and CRM fit
9. Future multi-industry expansion

## Provisionally approved stack

Not irrevocably locked for hosting, email, or billing. **Phase 02 locked Neon + Drizzle + Better Auth + RLS** for database and authentication. See [28-neon-vs-supabase.md](./28-neon-vs-supabase.md) and [12-decisions-log.md](./12-decisions-log.md).

| Layer | Choice | Independent reason |
|---|---|---|
| Language | TypeScript | Shared contracts across console, public API, and worker |
| Repo | pnpm workspaces + Turborepo | Separate `web`, `api`, and `worker` without splitting products |
| Console / marketing / admin | Next.js App Router + React + Tailwind | Commercial SaaS standard for authenticated product UI |
| Public API | Hono + Zod OpenAPI on Node | Versioned commercial APIs, OpenAPI as a product, always-on process |
| Worker | Node + BullMQ | Durable intelligence jobs, concurrency, retries |
| Database | PostgreSQL on Neon | Standard Postgres, branching, scale-to-zero staging, RLS |
| Access layer | Drizzle ORM + SQL migrations | Type-safe, close to SQL, good write-path performance |
| Auth | Better Auth (organizations) | B2B tenants, invites, roles; SSO hook later without a rewrite |
| Machine auth | First-party hashed API keys | Commercial API product, not user-session reuse |
| Broker / rate limits | Redis (Upstash or equivalent) | Queue + API quotas + short cache |
| Objects | Cloudflare R2 | Exports and artifacts, S3 API, low egress cost |
| Email | Resend | Auth, invites, billing, CRM, and decision notifications |
| Billing | Stripe Billing | Subscriptions, Checkout, Portal, Meters |
| CRM | First-party CRM objects + later Attio/HubSpot sync | GTM is part of a commercial SaaS, not an afterthought |
| Web host | Vercel | Native Next.js, preview deploys |
| API / worker host | Railway | Always-on processes, Redis adjacency, long jobs |
| Observability | Structured logs + Sentry at first staging deploy | Enough for v1; Axiom optional later |

No resources above are created in Phase 00.

## Why this shape

The product is three runtimes, not one monolith:

```text
apps/web      Next.js     humans
apps/api      Hono        commercial JSON API
apps/worker   BullMQ      intelligence compute
packages/*    shared      contracts, db, auth, policy engine
```

A single full-stack framework is a poor fit for all three. Console UX wants Next.js. A paid public API wants an always-on OpenAPI service with key auth and rate limits. Intelligence wants a worker that can run longer than a request.

## Criteria notes

### Security and multi-tenancy

Postgres row-level security remains mandatory. That is a **Postgres** control, not a reason to adopt Supabase. Better Auth owns browser sessions. The API service owns API keys. The worker never accepts a job without `tenant_id`. Redis keys and R2 paths are tenant-prefixed.

### API commercialization

Hono + Zod OpenAPI gives a published spec, generated types, and stable `/v1` routes. Rate limits live in Redis. Usage meters feed Stripe. This is a product surface, not an internal RPC layer.

### Intelligence workloads

Feature compute and policy evaluation run on the worker, not in the web request. BullMQ supports concurrency, delayed jobs, and poison-message isolation. Postgres stores features and Decision Records. If event volume outgrows Postgres analytics, add a warehouse later without changing the API contract.

### Cost and DX

Neon branches give staging and preview databases without a second ops model. Upstash Redis avoids running Redis on a laptop as a hard requirement later, while local Docker Redis is fine in Phase 01–04. Vercel is wasted on workers; Railway is wasted as the only Next.js host. Split them.

### CRM, email, Stripe

Resend, Stripe, and first-party CRM objects are platform concerns. They do not pass through any other product’s email host, membership catalog, or customer list.

### Multi-industry expansion

Industry-specific knowledge is a **pack**: connector types, decision types, and policy templates. The core schema stays generic. TCG is one pack, not the kernel.

## Rejected options

| Option | Why rejected |
|---|---|
| TanStack Start + Vite monolith | Optimized for one operational app, not a commercial API + worker platform |
| Copy TCG Card Central stack | Explicitly forbidden; couples a greenfield SaaS to an unrelated product |
| Supabase Auth / Supabase as the app platform | Convenient, weaker B2B org model, easy to over-couple to one vendor |
| Next.js-only API routes | Weaker OpenAPI product, request-time limits, mixes human and machine surfaces |
| NestJS | Strong for large API orgs; heavier than needed for a founding team |
| Prisma | Fine DX, heavier client for high-ingest write paths |
| Database-per-tenant | Ops cost too high for v1 |
| LLM-first engine | Opacity, cost, prompt-injection |
| Shared runtime or database with TCG Card Central | Breaks independence and security |
| Clerk as the only auth | Fast, but seat pricing and lock-in before SSO is required |
| All-in serverless | Intelligence jobs and API key rate limits need always-on workers |

## Open substitutions

These may change later without rewriting the product model:

- Redis vendor (Upstash vs Railway Redis vs self-hosted)
- Log vendor
- CRM sync target (Attio vs HubSpot)
- Whether `apps/api` and `apps/worker` share a Railway project

These may **not** change casually:

- Independent Postgres
- Independent auth
- Dedicated public API
- Dedicated worker
- Stripe as billing
- No TCG Card Central stack reuse
- TCG as the first commercial vertical (kernel stays industry-independent)
