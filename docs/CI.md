# CI checks

GitHub Actions workflow: `.github/workflows/ci.yml`.

## When it runs

- Every pull request
- Every push to `main`

## What it runs

Uses **Node 20** and **pnpm 11.22.0** (the repository’s declared package manager).

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`
5. `pnpm build`

Required checks are those five validation steps. The job name is `validate`.

## What it does not do

- Does not deploy to Vercel, Railway, or anywhere else
- Does not provision Neon
- Does not add production secrets to GitHub
- Does not run against a production database

Auth tests use in-memory PGlite. The Next.js build is allowed to succeed without `DATABASE_URL` / `BETTER_AUTH_SECRET`; database-backed routes fail clearly at runtime until those values are configured locally.
