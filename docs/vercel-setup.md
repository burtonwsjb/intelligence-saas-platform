# Vercel web setup (later)

Do not deploy from this document until the operator is signed in.

1. Vercel → Add New → Project → import this GitHub repo.
2. Root directory: repository root (not `apps/web`).
3. Framework preset: Next.js.
4. Node.js: 22.
5. Install command: `pnpm install --frozen-lockfile`
6. Build command: `pnpm --filter @isp/web... build` (see `vercel.json`).
7. Environment: `ISP_ENV=staging`, `APP_URL`, `BETTER_AUTH_URL`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `API_KEY_PEPPER`, plus admin DB vars if `/admin` is used.
8. Do not add `PLATFORM_ADMIN_EMAILS`.
9. Preview deployments should not share production Redis/DB.
