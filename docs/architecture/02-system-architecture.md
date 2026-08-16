# System architecture

## Shape

One monorepo. Three runtimes later. Independent data, auth, and billing.

```text
┌──────────────────────────┐     ┌──────────────────────────┐
│  apps/web                │     │  apps/api                │
│  Next.js                 │     │  Hono + OpenAPI          │
│  Vercel                  │     │  Railway                 │
│                          │     │                          │
│  /         marketing     │     │  /v1 ingest + commercial │
│  /app      TCG console   │     │  intelligence domains    │
│  /admin    CRM · ops     │     │  customer webhooks       │
│  /auth     Better Auth   │     │  /webhooks/stripe        │
└────────────┬─────────────┘     └────────────┬─────────────┘
             │                                │
             └──────────────┬─────────────────┘
                            │
                 ┌──────────▼──────────┐
                 │  Neon Postgres      │
                 │  RLS · Drizzle      │
                 └──────────┬──────────┘
                            │
             ┌──────────────┼──────────────┐
             │              │              │
   ┌─────────▼────┐  ┌──────▼─────┐  ┌─────▼─────┐
   │ apps/worker  │  │ Redis      │  │ R2        │
   │ BullMQ       │  │ queue/rl   │  │ artifacts │
   │ Railway      │  └────────────┘  └───────────┘
   └──────────────┘

Stripe · Resend · sources (YouTube, Reddit) · later TCC API
```

## Process responsibilities

### `apps/web`

- Marketing, tenant console, platform admin, CRM UI
- Browser sessions via Better Auth
- Server actions / BFF calls into internal modules or the API
- No heavy intelligence compute
- No public machine API as the product surface

### `apps/api`

- Commercial, versioned JSON API
- API key authentication, scopes, and Redis rate limits
- Ingest plus commercial intelligence domains (printings, creators, indices, predictions, opportunities)
- Customer webhooks (signed) and Stripe webhooks
- Published OpenAPI document
- Entitlement and meter checks before expensive work

### `apps/worker`

- Consume BullMQ jobs
- Ingest normalize, entity resolution, observations, signals
- TCG market bars, indices, opportunity scores, predictions
- Creator extraction, authority slices, outcomes
- Content evidence jobs
- Usage rollup and webhook delivery
- Optional outbound TCC reference API (sandbox/production per roadmap)

Phase 01 may run a single local process that only renders chrome. Production is three services.

## Request paths

### Browser session

1. User authenticates with Better Auth
2. Session includes `user_id` and selected `tenant_id`
3. Web app loads tenant-scoped data through Drizzle with RLS
4. Privileged mutations write audit rows

### Machine ingest

1. Client sends `Authorization: Bearer <api_key>` to `apps/api`
2. API looks up key hash, tenant, scopes, plan caps, and rate limit
3. Payload is Zod-validated
4. Event is stored with an idempotency key
5. A BullMQ job is enqueued
6. Client receives `202 Accepted` and an `event_id`

### Decision read

1. API key or session authenticates
2. Only that tenant’s Decision Records are returned
3. Filters: `decision_type`, `status`, `entity_id`, time range

### Later TCG Card Central paths

TCC is a foreign system.

- **TCC as customer:** TCC calls `/v1/events` and `/v1/decisions` with its tenant API key
- **TCC as provider:** this worker calls TCC’s future versioned API with credentials this platform stores for that connector

This platform never opens TCC’s database.

## Application modules

Logical packages. These are not created in Phase 00.

| Package / module | Responsibility |
|---|---|
| `contracts` | Zod / OpenAPI schemas |
| `db` | Drizzle schema and RLS helpers |
| `identity` | Better Auth, tenants, memberships |
| `keys` | API key issue, hash, rotate, revoke |
| `ingest` | event validation, idempotency |
| `entities` | resolution, attributes, links |
| `features` | computed attributes and freshness |
| `policies` | versioned rule documents |
| `decisions` | records, actions, receipts |
| `billing` | Stripe customer, subscription, meters |
| `crm` | accounts, contacts, opportunities, activities |
| `email` | Resend templates |
| `audit` | privileged action log |
| `connectors` | connector definitions and tenant instances |
| `packs` | industry catalogs and optional reference clients |

## Queue

**Broker:** Redis + BullMQ.

Postgres is not the primary queue. Postgres stores `job_runs` for observability and idempotent outcome tracking.

Job kinds (planned):

- `ingest.normalize`
- `features.refresh`
- `decisions.evaluate`
- `decisions.expire`
- `usage.rollup`
- `email.dispatch`
- `reference.sync` (later, pack-specific)

## Environments

| Name | Purpose | Cloud resources |
|---|---|---|
| `local` | Developer machine | Docker Postgres + Redis optional; none required for Phase 01 chrome |
| `staging` | Isolated cloud | Neon branch, Railway API/worker, Vercel preview/staging, Stripe test, Resend test |
| `production` | Paying tenants | Separate Neon, Railway, Vercel, Stripe live, Resend domain |

TCG Card Central environments are foreign. They are never environments of this repo.

## Data flow for one decision

```text
Customer system
  POST /v1/events
    → source_event stored
      → BullMQ ingest.normalize
        → entity upsert
          → features.refresh
            → decisions.evaluate
              → decision_record written
                → console / API can read it
                  → operator or customer posts receipt
```

## Explicit non-architecture

- No TCG Card Central runtime, framework, or vendor reuse
- No production API implementation in this phase
- No LLM in the v1 decision path
