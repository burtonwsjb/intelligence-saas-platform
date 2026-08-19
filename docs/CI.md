# CI checks

GitHub Actions workflow: `.github/workflows/ci.yml`.

## When it runs

- Every pull request
- Every push to `main`

## What it runs

Uses **Node 22** and **pnpm 11.22.0** (the repository’s declared package manager). pnpm 11 requires Node.js 22.13 or newer (`node:sqlite`).

Disposable `postgres:16-alpine` and `redis:7-alpine` services are started for RLS isolation and BullMQ ingest tests. Credentials in the workflow YAML are CI-only and are not production secrets.

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`
5. `pnpm test:isolation`
6. `pnpm test:integration`
7. `pnpm build`

Required checks are those steps. The job name is `validate`.

## What it does not do

- Does not deploy to Vercel, Railway, or anywhere else
- Does not provision Neon
- Does not add production secrets to GitHub
- Does not run against a production or shared database

Auth unit tests use in-memory PGlite. Isolation tests use the CI Postgres service and a non-superuser `app_user` role. Queue/ingest integration tests use the CI Postgres and Redis services. The Next.js build is allowed to succeed without `DATABASE_URL` / `BETTER_AUTH_SECRET`; database-backed routes fail clearly at runtime until those values are configured locally.
