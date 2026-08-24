# Neon provisioning (staging)

Do not create a Neon project from this repository. When authorized:

1. Neon console → New project. Region: choose the same region as Railway staging (often `us-east-1` / `aws-us-east-1`). Free/launch tier is enough for staging.
2. Database name: `isp_staging` (or default `neondb`).
3. Copy the **unpooled** connection string for migrations (`DATABASE_ADMIN_URL`). Enable `sslmode=require`.
4. Build the **pooled** restricted `app_user` URL and store it as `APP_DATABASE_URL` for hosted web/API. Do not point hosted runtime at a Neon Vercel integration `DATABASE_URL` (that credential is the owner/default role and cannot be edited in Vercel). Leave the integration-managed `DATABASE_URL` in place; hosted staging/production fail closed if `APP_DATABASE_URL` is absent.
5. Roles are **not** created by SQL migrations. Run `pnpm db:bootstrap` as the Neon owner using:
   - `APP_MIGRATE_PASSWORD`
   - `APP_USER_PASSWORD`
   - `APP_WORKER_PASSWORD`
   - `APP_ADMIN_PASSWORD`
6. `CREATE ROLE` requires the Neon project owner. There is no PostgreSQL superuser. `BYPASSRLS` is set on `app_migrate` and `app_admin` only. Runtime `app_user` / `app_worker` are `NOBYPASSRLS`.
7. `pnpm db:bootstrap` is idempotent for **correct** existing roles: it validates LOGIN / NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOINHERIT / expected BYPASSRLS and does **not** `ALTER ROLE` or rotate passwords. Incorrect attributes fail closed (Neon owners typically cannot `ALTER ROLE`).
8. `ALTER TABLE/FUNCTION ... OWNER TO app_migrate` is best-effort. Neon often cannot transfer ownership (the owner must also be able to `SET ROLE` the new owner). When transfer is denied, objects may remain owned by `neondb_owner`. Least-privileged equivalent: GRANT table/function privileges to `app_migrate` / `app_admin`; runtime stays `app_user` / `app_worker` with `NOBYPASSRLS` and FORCE RLS. Future schema migrations still use the Neon owner `DATABASE_ADMIN_URL`.
9. `GRANT CONNECT ON DATABASE` is skipped if the owner lacks privilege; Neon owner typically can grant it.
10. Do not use the local Docker superuser URL. Hosted admin DB without `APP_ADMIN_PASSWORD` fails closed.
11. RLS uses `set_config(..., true)` inside transactions with `prepare: false`, which is compatible with Neon/PgBouncer **transaction** pooling. Do not rely on session-level `SET` across pooled checkouts.
12. Worker should use `WORKER_DATABASE_URL` as role `app_worker`. Hosted worker does not fall back to `DATABASE_URL`.
