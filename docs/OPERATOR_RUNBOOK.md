# Operator runbook

Never paste secret values into tickets, chat, or this file. Use environment *names* only.

Related: [environments.md](environments.md), [staging-runbook.md](staging-runbook.md), [neon-provisioning.md](neon-provisioning.md), [production-security-checklist.md](production-security-checklist.md), [secret-rotation.md](secret-rotation.md), [CI.md](CI.md), [architecture/00-overview.md](architecture/00-overview.md).

## Architecture

- `apps/web` — Next.js customer + admin UI (Vercel)
- `apps/api` — Hono public API + Stripe webhook receiver (Railway)
- `apps/worker` — BullMQ worker (Railway)
- Neon Postgres with RLS roles
- Redis for queues
- Resend for transactional email
- Stripe **test** only until production is authorized

## Local setup

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm test:isolation
pnpm test:integration
pnpm build
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

Required local names only: see `.env.example`. Do not copy hosted secret values into local files that can be committed.

## Staging setup

- Vercel web, Railway API + worker, Neon, Redis, Resend.
- Do not enable live providers.
- Do not apply a migration unless it is listed as unapplied and you have a backup window.
- Worker heartbeat identity: run `pnpm --filter @isp/db staging-db-identity` after return. Do not keep debugging hosted heartbeat in this sprint.

## Production setup

Not authorized. See [PHASE_23_READINESS.md](PHASE_23_READINESS.md) and [production-security-checklist.md](production-security-checklist.md).

## Environment variables

Use names from `.env.example`. Critical classes:

- Database: `DATABASE_URL`, `APP_DATABASE_URL`, `DATABASE_ADMIN_URL`
- Auth: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_URL`
- Queue: `REDIS_URL`, `QUEUE_PREFIX`
- Email: `AUTH_EMAIL_MODE`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- Billing: Stripe test keys / webhook secret only
- Providers: `PROVIDER_DEFAULT_MODE` plus per-provider credentials
- API keys: `API_KEY_PEPPER`

Never commit values. Never put secrets in query strings or docs.

## Database roles

`app_migrate`, `app_user`, `app_worker`, `app_admin`. `app_user` / `app_worker` must not `BYPASSRLS`. Platform operators are `platform_admins` grants, not a tenant role.

## Neon

Provision a branch per environment. Apply committed migrations in order with the migrator role. After `0023`, no additional hosted migration from this sprint is waiting.

## Redis

Required for the worker. A Redis outage must not drop outbox rows. Worker health should report 503 while shutting down or if Redis is gone.

## Vercel / Railway

Web on Vercel. API and worker on Railway. Do not click hosted controls from this repository automation. Confirm `APP_DATABASE_URL` is loaded on the worker before chasing heartbeat mismatches.

## Provider activation

Modes are `disabled` | `fixture` | `live`. Live never infers from credential presence. Keep providers disabled until an operator explicitly sets live mode and has budget approval.

## Provider credentials

Stay in Railway/Vercel env, never in git. Rotating a provider token does not change mode.

## Migrations

Forward-only Drizzle files in `packages/db/drizzle`. Latest committed file: `0023_phase24_provider_runtime_grants.sql`. New-environment bootstrap applies all files then `bootstrapRoles`. Existing staging upgrades apply only the next unapplied file.

## Backups and restore

Use Neon PITR / branch restore. After restore, re-check role flags and `platform_admins`. Do not roll back a migration file in git without a restore plan.

## Worker and queue

Startup writes heartbeat. SIGTERM/SIGINT drain in-flight jobs (~20s) then exit. Job timeout 90s, lock 120s, stalled recovery max 2. Outbox dead-letters after 20 publish failures.

## Admin bootstrap

Grant `platform_admins` by email with the documented grant script. Do not use a tenant role. Break-glass actions must write audit evidence.

## Security incident response

1. Revoke sessions / API keys / webhook secrets involved
2. Rotate the leaked name from [secret-rotation.md](secret-rotation.md)
3. Keep RLS and platform-admin checks enabled
4. Do not disable authentication to “unblock” users

## Outages

| Failure | First check | Safe action |
|---|---|---|
| Database | Neon compute / `APP_DATABASE_URL` | Do not fail-open RLS |
| Redis | `REDIS_URL`, worker 503 health | Jobs stay in outbox |
| Worker | Admin Health overall status | Redeploy worker; do not enable live providers |
| Email | Resend logs, `AUTH_EMAIL_MODE` | Verification resend is rate-limited |
| Webhooks | consecutive failures, SSRF rejects | Retry from admin; do not disable signing |
| Billing | Stripe test webhook claims | Local simulation if Stripe is unset |
| Provider | Admin Sources + Health | Leave live mode off |

## Rollback

Revert the git SHA on Vercel/Railway. Do not roll back a forward-only migration without a restore plan.

## Release checklist

1. CI `validate` green including `git diff --check`
2. No new unapplied migration unless scheduled
3. Predictions still shadow
4. Providers still disabled unless explicitly activated
5. Secrets unchanged unless rotating with a dual-write plan
6. Money fixtures still show Greninja $41 and preserve the $4,000 outlier
