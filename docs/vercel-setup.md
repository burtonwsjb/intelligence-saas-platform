# Vercel web setup (later)

Do not deploy from this document until the operator is signed in.

1. Vercel → Add New → Project → import this GitHub repo.
2. Root directory: repository root (not `apps/web`).
3. Framework preset: Next.js.
4. Node.js: 22.
5. Install command: `pnpm install --frozen-lockfile`
6. Build command: `pnpm --filter @isp/web... build` (see `vercel.json`).
7. Environment: `ISP_ENV=staging`, `APP_URL`, `BETTER_AUTH_URL`, `APP_DATABASE_URL` (restricted pooled `app_user`), `BETTER_AUTH_SECRET`, `API_KEY_PEPPER`, `AUTH_EMAIL_MODE=resend`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, plus admin DB vars if `/admin` is used.
8. If the Neon Vercel integration created `DATABASE_URL`, leave it in place and do not use it for application runtime. Hosted web fails closed without `APP_DATABASE_URL`.
9. Do not add `PLATFORM_ADMIN_EMAILS`.
10. Preview deployments should not share production Redis/DB.
