# Phase 20 — Platform administration

Status: **implemented**. Do not begin Phase 21 (staging / Vercel / Railway / Neon) until explicitly instructed.

The operator console replaces the `/admin` placeholder. Platform admins are a server-checked `platform_admins` grant, not a tenant role. Local adapters remain the default. Neon, Railway, Vercel, live Stripe, and production Resend are not required.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/platform.ts` | Grants, break-glass audit, operator support cases |
| `packages/db/drizzle/0020_phase20_admin.sql` | Self-SELECT grant table; operator-only audit/support RLS |
| `packages/db/src/platform/` | Grant checks, audited inspect, creator exclude, health/config |
| `apps/web/app/admin/` | Operator console |

TCG Card Central is not used. Customer `/app` is unchanged. Predictions stay shadow for tenants.

## Grant model

- `platform_admins.user_id` is the source of truth.
- Tenant `app_user` may SELECT only their own grant row. INSERT is deny-all.
- `PLATFORM_ADMIN_EMAILS` is a **non-production** allowlist. Production ignores it.
- Cross-tenant CRM, notes, trust writes, and audit inserts use `app_admin` (BYPASSRLS).
- Production without `APP_ADMIN_PASSWORD` fails closed. Local Docker may use `DATABASE_ADMIN_URL` when the password is unset.

## Break-glass

Tenant inspection uses the system principal plus `app_admin`. It does **not** impersonate a tenant user session and does not inherit an unrestricted `app_user` path. Each inspect, creator trust change, index upsert, support case, and prediction preview writes `platform_break_glass_audit`. That table is append-only and is not mixed into tenant `audit_event`.

Raw source payloads, API keys, webhook secrets, and Stripe secrets are not displayed.

## Creator moderation (exit)

`excludeCreatorKeepingHistory` records an append-only `creator_trust_event` with `excluded` and recomputes authority. Call rows remain. Exclusion is not a delete.

## Console surfaces

Overview, customers (Phase 17 listings), customer inspect + operator notes, creator trust, index specs, source health, shadow prediction preview, support cases, system health, sanitized config, break-glass audit.

## Phase 21 boundary

Do not provision Vercel, Railway, Neon staging, or run production load tests here.
