# Staging deployment runbook

Status: prepared. **Do not run this until the operator has created the accounts and pasted secrets into the host dashboards — not into chat.**

Independent staging is required for full Phase 21. This repository is ready; cloud resources are not created here.

Conceptual hosts (placeholders, no DNS purchase):

- Web: Vercel default hostname, later `staging.<future-domain>`
- API: Railway default hostname, later `api-staging.<future-domain>`
- Worker: Railway service, no public hostname required

Do not use TCG Card Central infrastructure.

## Order

1. Neon project + database + roles (see [neon-provisioning.md](./neon-provisioning.md))
2. Managed Redis (TLS if the vendor exposes `rediss://`)
3. Run `pnpm db:migrate` then `pnpm db:bootstrap` against the **unpooled** Neon admin URL
4. Railway API service from `apps/api/Dockerfile` (repo root as build context)
5. Railway worker service from `apps/worker/Dockerfile` (separate service, separate start command)
6. Vercel web project at repository root (`vercel.json`, pnpm 11.22, Node 22)
7. Confirm `GET https://<api>/health` and `GET /ready`
8. Confirm web login against staging `APP_URL` / `BETTER_AUTH_URL`

## Environment values (names only)

Shared:

- `ISP_ENV=staging`
- `NODE_ENV=production`
- `APP_URL=https://<vercel-host>`
- `BETTER_AUTH_URL` same as `APP_URL`
- `API_URL=https://<railway-api-host>`
- `QUEUE_PREFIX=staging`
- `BILLING_MODE=stripe_test`
- `AUTH_EMAIL_MODE=resend`
- `PREDICTIONS_CUSTOMER_VISIBLE` unset or `false`
- Do **not** set `PLATFORM_ADMIN_EMAILS`

API:

- `PORT` provided by Railway
- `DATABASE_URL` Neon pooled `app_user`
- `REDIS_URL`
- `API_KEY_PEPPER`
- `BETTER_AUTH_SECRET` not required on API unless shared auth is added later

Worker:

- `WORKER_DATABASE_URL` Neon `app_worker` (unpooled or session mode if SET LOCAL is used; this app uses transaction-local `set_config`, so transaction pooling is OK)
- `REDIS_URL`, `QUEUE_PREFIX=staging`
- Do not start the API process in the worker service

Web:

- `DATABASE_URL` Neon pooled `app_user`
- `DATABASE_ADMIN_URL` + `APP_ADMIN_PASSWORD` for `/admin` break-glass
- `BETTER_AUTH_SECRET` (≥32 chars)
- `API_KEY_PEPPER`

Billing stays Stripe **test**. Email is Resend (staging key). Predictions remain shadow until `/admin/beta` enables `predictions_customer_visible`.

## Vercel project (later)

- Root directory: repository root (workspace packages)
- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter @isp/web... build`
- Node 22, pnpm 11.22.0
- Framework: Next.js

## Railway API (later)

- Dockerfile path: `apps/api/Dockerfile`
- Healthcheck: `/health`
- Start: `node apps/api/dist/index.js`

## Railway worker (later)

- Dockerfile path: `apps/worker/Dockerfile`
- Start: `node apps/worker/dist/index.js`
- Optional `WORKER_HEALTH_PORT` only if the platform requires an HTTP probe
