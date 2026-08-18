# Phase 02 — database, authentication, tenant foundation, and CI

Status: **implemented locally**. Phase 03 has **not** started.

Cloud Neon is **not** provisioned in this phase. Local development uses disposable Postgres (Docker) or in-memory PGlite for tests. The recorded cloud provider remains Neon.

## Final stack decision

| Layer | Choice |
|---|---|
| PostgreSQL (cloud) | Neon |
| ORM / schema / migrations | Drizzle |
| Authentication | Better Auth 1.7.x with the organization plugin |
| Tenant security | PostgreSQL Row Level Security (foundation now; isolation tests in Phase 03) |
| Web | existing Next.js app (`apps/web`) |
| API | existing Hono app (`apps/api`) |
| Worker | existing Node worker (`apps/worker`) |

Do **not** use Supabase. Do **not** use TCG Card Central infrastructure.

This decision is recorded in [architecture/12-decisions-log.md](./architecture/12-decisions-log.md) and [architecture/28-neon-vs-supabase.md](./architecture/28-neon-vs-supabase.md).

## Neon rationale

Neon is the Phase 02 database vendor because:

- It is standard PostgreSQL, which is required for RLS.
- Database branching fits later staging and preview work.
- Auth stays in Better Auth, so database and identity can be replaced independently.
- It does not couple this product to TCG Card Central’s Supabase project.

A Neon project is **not** created in this phase. Create one only when a later prompt asks for cloud provisioning.

## Better Auth architecture

Consulted current Better Auth documentation for 1.7.x:

- [Next.js integration](https://www.better-auth.com/docs/integrations/next) (`toNextJsHandler`, `nextCookies()` last, Next.js 16 `proxy.ts`)
- [Drizzle adapter](https://www.better-auth.com/docs/adapters/drizzle) (`@better-auth/drizzle-adapter`)
- [Organization plugin](https://www.better-auth.com/docs/plugins/organization) (organizations, memberships, invitations, roles, access control, active organization)

Capabilities in this phase:

- Email + password signup
- Email verification required before login
- Login, logout, session
- Organization create / list / set-active
- Creator role is `owner`
- Custom organization roles are registered now; feature permissions stay minimal

A user may belong to multiple organizations. v1 UI focuses on one **active** organization resolved from the server session (`session.activeOrganizationId`). The client cannot become a member of a foreign organization by submitting an arbitrary ID.

## Auth-owned vs application-owned tables

### Better Auth-owned (do not tenant-RLS these)

| Table | Purpose |
|---|---|
| `user` | Person identity |
| `session` | Session token, expiry, `active_organization_id` |
| `account` | Credential / provider records (password hash lives here) |
| `verification` | Email verification and similar tokens |
| `organization` | Tenant identity: name, slug |
| `member` | Organization membership and role |
| `invitation` | Organization invitations |

### Application-owned

| Table | Purpose |
|---|---|
| `tenant` | 1:1 extension of `organization`. Holds status and created-by metadata for isolation work. Primary key is `organization_id`. |

- Better Auth-owned tables include `account.issuer` (required by Better Auth 1.7).

## Organization / tenant boundary

- Billing and data-isolation root = Better Auth **organization**.
- Application `tenant` row is created after organization creation (`organizationHooks.afterCreateOrganization`).
- Membership and roles stay on Better Auth `member`.
- Future API keys must bind to exactly one organization/tenant id.
- Platform admin is **not** a tenant role. `/admin` remains a placeholder with no privileged data.

## Local setup

1. Copy `.env.example` to a local untracked `.env` at the repo root (and/or `apps/web/.env.local`).
2. Generate `BETTER_AUTH_SECRET` locally (32+ characters). Do not paste it into chat or git.
3. Start disposable Postgres:

```bash
docker compose up -d postgres
```

4. Set `DATABASE_URL` to the local Docker URL from `.env.example` comments / `docker-compose.yml` (user `isp`, database `isp`). Never commit the filled file.
5. Apply migrations:

```bash
pnpm db:migrate
```

6. Run the web app:

```bash
pnpm dev:web
```

`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` do **not** require Docker or Neon. Auth integration tests use PGlite.

## Environment variables

Names only. Real values stay in untracked local files.

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | server only | Postgres connection. Throws `MissingDatabaseUrlError` if missing when DB is used. |
| `BETTER_AUTH_SECRET` | server only | Auth signing secret. Throws `MissingAuthSecretError` if missing/short. |
| `BETTER_AUTH_URL` | server only | Auth base URL, default `http://localhost:3000`. |
| `APP_URL` | server only | Trusted origin for CSRF/origin checks. |
| `AUTH_EMAIL_MODE` | server only | Local email strategy. Default for non-production: `file`. |
| `NODE_ENV` | server | `production` enables secure cookies and fails closed without Resend. |

Never expose `DATABASE_URL` or `BETTER_AUTH_SECRET` to the browser. `apps/web/lib/auth.ts` is `server-only`.

## Migration workflow

Versioned SQL lives in `packages/db/drizzle/`.

```bash
pnpm db:generate   # drizzle-kit generate from schema (review the SQL)
pnpm db:migrate    # apply SQL files to DATABASE_URL
pnpm db:status     # list versioned SQL files
```

From an empty development database, `pnpm db:migrate` is enough.

Rollback / recovery:

- Local/disposable databases may be destroyed and recreated.
- Do **not** run destructive reset commands against any shared, staging, or production database.
- There is no production database yet. Recovery is: recreate the local database and re-apply migrations.

## Authentication flow

1. Visitor opens `/signup`.
2. Better Auth creates the user and credential records.
3. `requireEmailVerification` is on. A verification URL is produced.
4. Local delivery writes `.local/verification-url.txt` under the Next.js working directory (typically `apps/web/.local/`). It does **not** send production email and does **not** log the URL.
5. User opens the link, then signs in at `/login`.
6. Session cookies are HTTP-only. Production uses secure cookies. Session cookie cache is disabled so the active organization is read from the database session row.

`log` mode exists only as an explicit local override and logs the recipient address, not the verification URL.

Production without Resend **fails closed**. Phase 17 (CRM / email) must configure Resend and set a production-safe `AUTH_EMAIL_MODE` / provider. Do not weaken production checks for local convenience.

## Onboarding flow

Unauthenticated visitor → `/signup` → email verification → `/login` → `/onboarding` (create workspace) → owner membership + `tenant` row → `/app`.

`/app` is protected:

- `proxy.ts` redirects when no session cookie exists (optimistic only).
- The page calls `auth.api.getSession({ headers })` and requires `activeOrganizationId` from that server session.

If the user already has an organization, onboarding activates the first membership instead of creating a second required org. Creating additional organizations remains possible later through Better Auth; v1 UI does not build a switcher.

## Test commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

CI runs the same commands after `pnpm install --frozen-lockfile`. See [CI.md](./CI.md).

Auth/tenant tests live in `packages/auth` (PGlite) and `apps/web` (route protection, input validation, committed-secret scan). API `/health` and the worker no-op tests remain.

## Local authentication smoke test

Requires local Docker Postgres and a filled untracked `.env` / `apps/web/.env.local`.

1. `docker compose up -d postgres`
2. `pnpm db:migrate`
3. `pnpm dev:web`
4. Open `http://localhost:3000/signup`
5. Create an account
6. Open `apps/web/.local/verification-url.txt` (or repo `.local/` if that is the cwd) and visit the URL
7. Sign in
8. Create a workspace name
9. Confirm `/app` shows the signed-in email and server-resolved organization id
10. Sign out
11. Confirm `/app` redirects to `/login`

Do not use a production database. Do not paste secrets or verification URLs into chat.

## Security decisions

- Session cookies: HTTP-only; `secure` in production; cookie cache disabled so active organization is database-backed
- CSRF/origin: Better Auth defaults remain enabled (`disableCSRFCheck: false`), `trustedOrigins` includes `APP_URL`
- Tenant switching is server-side `setActiveOrganization` and requires membership
- Organization create/membership mutations go through Better Auth APIs, not client-trusted IDs
- Passwords, session tokens, and Authorization headers are not logged
- `.env` is gitignored; `.env.example` has names only
- RLS is enabled and forced on `tenant`
- Better Auth tables are not RLS’d in a way that would break auth
- `/admin` exposes no tenant or operator data

## Known limitations

- Tenant isolation is **not** complete. Superuser connections (Docker `isp`, PGlite) bypass RLS even with `FORCE ROW LEVEL SECURITY`. Phase 03 must use a non-superuser `app_user` and add hop tests.
- Custom roles are registered (`owner`, `admin`, `developer`, `analyst`, `marketing`, `billing`, `viewer`) without implementing every future permission.
- No production email. Local file delivery only.
- No Neon cloud database yet.
- No Stripe, Redis/BullMQ jobs, TCG intelligence, or Lovable UI.
- No platform admin console.

## Phase 03 handoff

Phase 03 should:

1. Create a non-superuser database role and connect the app as that role.
2. Add isolation tests that prove a member cannot read another tenant’s `tenant` row or future tenant-owned tables.
3. Expand RLS to every new tenant-owned table.
4. Keep Better Auth-owned tables outside tenant RLS unless Better Auth documents a compatible pattern.
5. Add audit logging if required by the security architecture.
6. Do not start TCG identity, market ingest, or Stripe.

Do not mark Phase 03 complete from this document.
