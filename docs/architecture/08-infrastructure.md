# Infrastructure

No cloud resources are created in Phase 00. No TCG Card Central infrastructure is used.

## Target topology

```text
GitHub  burtonwsjb/intelligence-saas-platform
   │
   ├── apps/web     → Vercel staging / production
   ├── apps/api     → Railway staging / production
   └── apps/worker  → Railway staging / production

Data plane (independent):
   Neon Postgres (staging branch / prod)
   Redis (Upstash or Railway)
   Cloudflare R2
   Resend
   Stripe test / live
```

Local development does not require Vercel or Railway. Phase 05 uses disposable Docker Redis (`redis:7-alpine` on `6379`) and does **not** provision Upstash, Railway Redis, or any cloud Redis account.

## Planned services (later)

| Service | Host | Notes |
|---|---|---|
| `web` | Vercel | Next.js |
| `api` | Railway | Hono, `PORT` |
| `worker` | Railway | BullMQ consumer |
| `postgres` | Neon | RLS enabled |
| `redis` | Upstash or Railway | Queue and rate limits |
| `objects` | Cloudflare R2 | Exports and artifacts |

## Planned variable names only

- `ISP_ENV` (`local` \| `test` \| `staging` \| `production`)
- `DATABASE_URL`
- `REDIS_URL` (server-side; local `redis://localhost:6379`)
- `QUEUE_PREFIX` (optional `isp-{prefix}-ingest` segment; not a secret)
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `API_KEY_PEPPER`
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
- `RESEND_API_KEY`
- `STRIPE_SECRET_KEY` (Phase 07+)
- `STRIPE_WEBHOOK_SECRET` (Phase 07+)
- `APP_URL`
- `API_URL`

Later, only if the TCG pack is implemented:

- `TCC_API_BASE_URL`
- `TCC_API_TOKEN` or HMAC secret

Do not copy variables from any other product.

## Domains

Production hostname is TBD. Docs use `https://app.example.invalid` and `https://api.example.invalid` as placeholders. Do not buy or attach a domain in this phase.

## CI

GitHub Actions `validate` job (see [docs/CI.md](../CI.md)):

- disposable Postgres + Redis
- install, typecheck, lint, unit tests, isolation tests, queue/ingest integration tests, build
- no production deploy from pull requests

## Secrets

- `.env` is local only and never committed
- Vercel, Railway, Neon, and R2 hold cloud secrets
- API keys are hashed before storage
- Connector secrets use a `secret_ref`

## Backups

Neon point-in-time recovery on production when the project is created. Tenant export is a later feature.

## Observability

v1:

- structured JSON logs
- Vercel / Railway logs
- `job_runs` rows
- audit log
- Sentry at first staging deploy

## What Phase 01 may do locally

- pnpm monorepo shell
- Next.js chrome only
- Stub api/worker packages
- `.env.example` with names only
- No Neon, Railway, Vercel, Stripe, Resend, Redis cloud, R2, or TCG Card Central projects

Phase 01 may **not** create cloud resources or implement TCG intelligence.
