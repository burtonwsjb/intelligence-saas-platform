# Phase 23 — Production readiness

Status: **PRODUCTION READINESS PREPARED**  
**PRODUCTION NOT AUTHORIZED**

This file is a checklist so a later production deploy is controlled. It does **not** complete Phase 23. Do not deploy production, enable Stripe live, connect real TCG Card Central production, or change DNS from this work.

## 23A Production env (names only)

Classify every production variable as required secret, required public, optional, derived, or provider-specific. Values stay in the host secret store.

Required secrets: `BETTER_AUTH_SECRET`, `API_KEY_PEPPER`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `APP_MIGRATE_PASSWORD`, `APP_USER_PASSWORD`, `APP_WORKER_PASSWORD`, `APP_ADMIN_PASSWORD`, `REDIS_URL`, `RESEND_API_KEY`, Stripe test (or later live only after explicit authorization), provider tokens.

Required public: `ISP_ENV=production`, `NODE_ENV=production`, `APP_URL`, `BETTER_AUTH_URL`, `API_URL`, `QUEUE_PREFIX=production`.

Forbidden: `PLATFORM_ADMIN_EMAILS`, `BILLING_MODE=local_simulation`, `sk_live_` until authorized, staging hostnames in `APP_URL`.

See [environments.md](./environments.md) and [production-security-checklist.md](./production-security-checklist.md).

## 23E Deployment order

Infrastructure → database → roles → migration → API → worker → web → health → providers → billing → email → beta smoke → traffic.

## 23F Rollback

Prefer forward-fix database migrations. Web/API/worker roll back by redeploying the previous image. Do not assume `DOWN` SQL exists.

## 23L Launch

Production is not ready until every external gate is explicitly completed by an operator. See [production-release-checklist.md](./production-release-checklist.md).
