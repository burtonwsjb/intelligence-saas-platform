# Moving Sentiment's database from Neon to Supabase

**Decision (owner, 2026-10-12):** the hosted database moves from Neon to Supabase Postgres.
It supersedes the Phase 02 vendor choice in [architecture/28-neon-vs-supabase.md](architecture/28-neon-vs-supabase.md).
What does not change: Drizzle, our own SQL migrations, PostgreSQL RLS, Better Auth, the four
application roles (`app_migrate`, `app_user`, `app_worker`, `app_admin`), and first-party API keys.
Supabase is used as plain Postgres only. Supabase Auth, Storage and the Data API are not used.

The Supabase project must be a **new** project for Sentiment. Never use TCG Card Central's
Supabase project; the two products must not share a database (PROJECT_SOURCE_OF_TRUTH.md).

This runbook is for an authorized maintenance window. It does not change production. Every
step that writes to a hosted database or hosted environment needs the owner's go-ahead.

## What the code already handles

| Concern | Where |
|---|---|
| Driver | `postgres` (postgres.js) with `prepare: false`; no Neon driver is used. Works on Supavisor transaction mode. |
| TLS | `packages/db/src/client.ts` turns TLS on for `*.supabase.co` / `*.supabase.com` hosts (and `sslmode=require`). |
| RLS context | `set_config(..., true)` inside transactions and only `pg_advisory_xact_lock`; safe on transaction pooling. |
| Target identity | `describeDatabaseTarget` (`packages/shared/src/db-host.ts`) treats `db.<ref>.supabase.co` and `aws-0-<region>.pooler.supabase.com` with user `<role>.<ref>` (port 5432 or 6543) as one project. Used by `staging-db-identity`, the admin discovery runtime check and `scripts/staging-target-check.mjs`. |
| Data API exposure | `pnpm db:bootstrap` revokes every privilege `anon` and `authenticated` hold on `public`/`app` and removes the default grants Supabase adds for new tables. It is a no-op where those roles do not exist. |
| Test safety | Isolation tests refuse Supabase hosts the same way they refuse Neon. |

## 1. Create the Supabase project (owner)

1. Supabase dashboard, New project in Brian's organization. Name it e.g. `sentiment-staging`.
   Region: same as Railway staging (US East, `us-east-1`). Save the database password in the password manager.
2. Project Settings, Data API: turn the Data API **off** (or remove `public` from exposed schemas).
   Bootstrap also revokes the grants, so this is defence in depth.
3. Project Settings, Database: leave connection pooling on (Supavisor).
4. Note the project ref (20 lowercase characters in the dashboard URL).

## 2. Connection strings

Railway and Vercel reach the direct host `db.<ref>.supabase.co` only over IPv6 unless the IPv4
add-on is bought. Use the Supavisor pooler for everything hosted; the username carries the project ref.

| Variable | Used by | Value |
|---|---|---|
| `DATABASE_MIGRATE_URL`, `DATABASE_ADMIN_URL` (maintenance shell only) | `db:migrate`, `db:bootstrap` | `postgresql://postgres.<ref>:<db password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require` (session mode) |
| `APP_DATABASE_URL` | Vercel web, Railway API | `postgresql://app_user.<ref>:<APP_USER_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require` |
| `WORKER_DATABASE_URL` | Railway worker | `postgresql://app_worker.<ref>:<APP_WORKER_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require` |
| `DATABASE_ADMIN_URL` (hosted admin runtime) | operator tooling | `postgresql://app_admin.<ref>:<APP_ADMIN_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require` |

Copy the exact pooler hostname from the dashboard's Connect panel; the `aws-0-us-east-1` prefix varies.
Remove any Neon Vercel integration `DATABASE_URL` once the cutover is confirmed.

## 3. Prepare the empty Supabase database (maintenance shell)

```sh
export ISP_ENV=staging
export DATABASE_MIGRATE_URL='<session pooler URL as postgres.<ref>>'
export DATABASE_ADMIN_URL="$DATABASE_MIGRATE_URL"
pnpm db:migrate -- --plan     # expect all 0001..0033 pending, nothing applied
pnpm db:migrate               # creates schema and the _isp_migration_history ledger
APP_MIGRATE_PASSWORD=... APP_USER_PASSWORD=... APP_WORKER_PASSWORD=... APP_ADMIN_PASSWORD=... \
  pnpm db:bootstrap           # creates the four roles, grants, Supabase anon lockdown
```

Supabase's `postgres` role is not a superuser but has `CREATEROLE` and `BYPASSRLS`, so bootstrap can
create the roles with the expected flags. Ownership transfer to `app_migrate` is best-effort, as on Neon.

Check: `select rolname, rolbypassrls from pg_roles where rolname like 'app_%'` shows
`app_user`/`app_worker` with `false`, and
`select has_table_privilege('anon','public.tcg_printing','SELECT')` returns `false`.

## 4. Copy staging data from Neon

1. Agree a quiet window. Pause the Railway worker (and any live staging test writing prices) so
   Neon stops changing. API/web may stay up read-only.
2. On Neon, confirm the ledger is complete: `pnpm db:migrate -- --plan` with `DATABASE_MIGRATE_URL`
   pointing at Neon must report nothing pending. If anything is pending or drifted, stop.
3. Dump data only, using a `pg_dump` at least as new as Neon's server version:

   ```sh
   pg_dump "$NEON_OWNER_URL" --data-only --no-owner --no-acl \
     --schema=public --schema=app \
     --exclude-table='public.playing_with_neon*' \
     --exclude-table-data='public._isp_migration_history' \
     -f sentiment-neon-data.sql
   ```

4. Load it into Supabase with triggers and FK checks deferred for the load only
   (Supabase lets `postgres` set `session_replication_role`):

   ```sh
   psql "$DATABASE_MIGRATE_URL" -v ON_ERROR_STOP=1 \
     -c 'SET session_replication_role = replica' -f sentiment-neon-data.sql
   ```

   The dump's `setval` calls carry sequences over. The ledger is not copied because step 3 wrote
   the same rows from the same migration files.

5. Compare exact row counts on both databases and diff the output:

   ```sql
   select table_name,
          (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
   from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'playing_with_neon%'
   order by 1;
   ```

## 5. Switch the runtimes

1. Set `APP_DATABASE_URL` (Vercel web, Railway API), `WORKER_DATABASE_URL` (Railway worker) and
   the admin URL to the Supabase values from section 2. Redeploy.
2. `pnpm --filter @isp/db staging-db-identity` should show `host_kind=supabase_pooler`, the same
   `supabase_project` for admin/app/worker and `same_*: yes`.
3. Unpause the worker. Check `/health`, worker heartbeat, a catalog/price-history run and a sign-in.
4. Record the new deployed target for repair preflight:
   `node scripts/staging-target-check.mjs --expected-target <fingerprint>` (see docs/REPAIR_RELEASE.md).

## Rollback

Neon is left untouched. Until Supabase has run cleanly for a week, rolling back is setting the three
URLs back to the Neon values and redeploying. Writes made on Supabase after cutover would need to be
copied back the same way. Delete the Neon project only after the owner confirms.

## Production

Same steps with a separate Supabase project (`sentiment-production`), only when production is authorized.
