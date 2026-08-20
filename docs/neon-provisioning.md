# Neon provisioning (staging)

Do not create a Neon project from this repository. When authorized:

1. Neon console → New project. Region: choose the same region as Railway staging (often `us-east-1` / `aws-us-east-1`). Free/launch tier is enough for staging.
2. Database name: `isp_staging` (or default `neondb`).
3. Copy the **unpooled** connection string for migrations (`DATABASE_ADMIN_URL`). Enable `sslmode=require`.
4. Copy the **pooled** connection string for `app_user` (`DATABASE_URL`).
5. Roles are **not** created by SQL migrations. Run `pnpm db:bootstrap` as the Neon owner using:
   - `APP_MIGRATE_PASSWORD`
   - `APP_USER_PASSWORD`
   - `APP_WORKER_PASSWORD`
   - `APP_ADMIN_PASSWORD`
6. `CREATE ROLE` requires the Neon project owner. There is no PostgreSQL superuser. `BYPASSRLS` is set on `app_migrate` and `app_admin` only. Runtime `app_user` / `app_worker` are `NOBYPASSRLS`.
7. `GRANT CONNECT ON DATABASE` is skipped if the owner lacks privilege; Neon owner typically can grant it.
8. Do not use the local Docker superuser URL. Hosted admin DB without `APP_ADMIN_PASSWORD` fails closed.
9. RLS uses `set_config(..., true)` inside transactions with `prepare: false`, which is compatible with Neon/PgBouncer **transaction** pooling. Do not rely on session-level `SET` across pooled checkouts.
10. Worker should use `WORKER_DATABASE_URL` as role `app_worker`.
