# Phase 03 — RLS, RBAC, tenant isolation, and fail-closed database access

Status: **implemented**. Phase 04 has **not** started.

Cloud Neon is still **not** provisioned. Isolation is proven with disposable PostgreSQL in CI and optionally local Docker.

## Role model

| Role | Superuser | BYPASSRLS | Owns tenant tables | Used by |
|---|---|---|---|---|
| `app_migrate` | no | yes | yes | migrations / provisioning |
| `app_user` | no | no | no | web/API runtime |
| `app_worker` | no | no | no | reserved for later jobs |
| `app_admin` | no | yes | no | future break-glass only |

`app_user` and `app_worker` receive DML on Better Auth identity tables and tenant-owned application tables. They have SELECT/INSERT only on `audit_event`. They cannot CREATE/DROP/ALTER schema objects, disable RLS, or `SET ROLE` into migrate/admin.

`CREATE ROLE` is **not** in versioned schema migrations. Hosted Postgres (Neon) often forbids arbitrary role creation from the app. Roles are created by `pnpm db:bootstrap` at database provisioning.

## Connection model

| Variable | Role | Use |
|---|---|---|
| `DATABASE_URL` | `app_user` | Application runtime. Browser never sees this. |
| `DATABASE_ADMIN_URL` | provisioner / migrate | `pnpm db:migrate` and `pnpm db:bootstrap` |
| `APP_*_PASSWORD` | bootstrap only | Local untracked passwords for the four roles |

Missing `DATABASE_URL` throws `MissingDatabaseUrlError`. Missing `DATABASE_ADMIN_URL` throws `MissingDatabaseAdminUrlError` when migrating/bootstrapping.

## RLS context model

`withOrganizationContext` / `withTenantScope` open a transaction and set:

- `app.current_organization_id`
- `app.current_user_id`

with `set_config(..., true)` so values are transaction-local and do not leak across pooled connections. Context is validated (`[A-Za-z0-9_:-]{1,128}`) before use. Repository helpers call `assertTenantContext()` and refuse to run outside a scope.

SQL helpers `app.current_organization_id()`, `app.current_user_id()`, `app.has_active_membership()`, and `app.tenant_is_active()` are `STABLE`, pin `search_path`, and are not `SECURITY DEFINER`.

## Active tenant policy

The Phase 02 “member of any organization” OR-clause is removed.

Every tenant-owned policy requires:

1. `row.organization_id = app.current_organization_id()`
2. `app.has_active_membership()` for that same organization and user

`tenant_resource` also requires `app.tenant_is_active()`.

A user who belongs to A and B, with active context A, cannot read B in that request.

## Tenant-owned table standard

Future tenant-owned tables must have:

- `organization_id` NOT NULL, FK to `organization`
- index on `organization_id`
- `ENABLE` + `FORCE ROW LEVEL SECURITY`
- separate SELECT / INSERT / UPDATE / DELETE policies
- active-organization + membership checks
- `tenant_is_active()` for normal application data

`tenant_resource` is the canonical example and the Phase 03 isolation fixture. It is not a TCG table.

`tenant` itself allows SELECT/INSERT/UPDATE under membership so the app can read `suspended`/`deleted` status and fail closed. `app_user` has no DELETE policy on `tenant`.

## RBAC

Server-side helpers in `@isp/auth`:

- `canAdminTenant` — owner
- `canManageMembers` — owner, admin
- `canManageApiKeys` — owner, admin, developer
- `canViewAnalytics` — owner, admin, developer, analyst, marketing, billing, viewer
- `canManageBilling` — owner, billing
- `canManageContent` — owner, admin, marketing

Unknown roles fail closed. Frontend hiding is not authorization. Platform admin is not a tenant role.

## Tenant switching

`authorizeOrganizationSwitch` treats a requested organization ID as a target, not a security principal. It validates input server-side, checks `member` server-side, then checks tenant status. Foreign, missing, stale, suspended, and deleted targets fail closed. After a valid switch, Better Auth stores the active organization on the session; later queries use that server-resolved id as RLS context.

## Tenant status

| Status | Normal application access |
|---|---|
| `active` | allowed |
| `suspended` | denied (`TenantInactiveError` + RLS on `tenant_resource`) |
| `deleted` | denied (soft; no hard delete) |

Billing-only owner exceptions belong to a later billing phase.

## Audit log

`audit_event` is application-owned and tenant-scoped: id, organization_id, actor_user_id, action, target_type, target_id, metadata, created_at.

Normal application behavior is append-only. `app_user` cannot UPDATE/DELETE audit rows. Platform break-glass audit should be a later separate table, not mixed into tenant audit.

## Platform admin boundary

- Not an organization role
- `/admin` remains a non-privileged placeholder
- `app_user` cannot become platform admin
- Future break-glass uses `app_admin` / a separate path and must be audited
- Impersonation must not inherit unrestricted database access

## Test strategy

- Unit tests (PGlite / pure functions): auth, RBAC, tenant switch/status, context parsing
- Isolation tests (`pnpm test:isolation`): real PostgreSQL, non-superuser `app_user`, CRUD hops, multi-membership active-tenant, no/wrong context, suspended/deleted, no BYPASSRLS, no SET ROLE, no policy changes, no audit rewrite

PGlite is not used to claim RLS isolation.

## CI Postgres

`.github/workflows/ci.yml` starts `postgres:16-alpine` with disposable `isp_admin` / `isp_ci_only` / `isp_ci`. Isolation tests bootstrap `app_*` roles themselves. No GitHub production secrets. No deploy.

## Migration / bootstrap

```bash
pnpm db:migrate      # DATABASE_ADMIN_URL
pnpm db:bootstrap    # CREATE/ALTER ROLE + GRANT; needs APP_*_PASSWORD
pnpm db:status
```

Schema migrations are replayable SQL under `packages/db/drizzle/`. Role bootstrap is provisioning-only.

## Local setup

1. `docker compose up -d postgres`
2. Untracked `.env`: `DATABASE_ADMIN_URL` as the Docker superuser URL (`isp` / `isp_dev_only` / `isp`)
3. `pnpm db:migrate`
4. Set local-only `APP_*_PASSWORD` values and run `pnpm db:bootstrap`
5. Set `DATABASE_URL` to the `app_user` URL
6. `pnpm test` and `pnpm test:isolation`

Do not paste passwords or connection strings into chat.

## Known limitations

- Neon cloud is not provisioned. Neon role creation must be run as a privileged provisioner later.
- `app_worker` exists but the worker still does not query tenant data.
- `app_admin` is created and unused.
- Not every future product permission is implemented.
- No Stripe, API keys, or TCG tables.

## Phase 04 handoff

Phase 04 may add Stripe test mode, entitlements, and hashed API keys. API keys must bind to exactly one tenant and use the same active-tenant RLS pattern. Do not weaken `app_user` grants to do that.
