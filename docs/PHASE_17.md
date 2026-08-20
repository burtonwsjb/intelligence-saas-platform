# Phase 17 — CRM, customer lifecycle, email, notifications, and billing completion foundation

Status: **implemented**. Phase 18 is complete; see [PHASE_18.md](PHASE_18.md). Phase 19 has **not** started.

The first-party SaaS customer lifecycle exists around Better Auth users and organizations. Local simulation remains the default billing mode. Real Stripe Checkout/Portal, Resend production delivery, Neon, Railway, and Vercel are not required.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/crm.ts` | Tenant CRM profile, timeline, churn; operator notes/tags/segments |
| `packages/db/src/schema/notification.ts` | Preferences, in-app inbox, alert rules, usage warnings, email delivery log |
| `packages/db/drizzle/0017_phase17_crm.sql` | RLS for tenant CRM/notifications; operator-only RLS for notes/tags/segments |
| `packages/db/src/crm/` | Lifecycle, activation.v1, events, health.v1, admin queries |
| `packages/db/src/notifications/` | Preferences, inbox, alerts, usage-warning dedupe, delivery log |
| `packages/auth/src/mail/` | `EmailProvider`, Local/Fixture/Resend adapters, escaped templates |
| `packages/billing/src/policy.ts` | Configurable trial window; non-destructive past-due/canceled retention |
| `apps/web/app/app/billing/page.tsx` | Plan, trial, entitlements, usage, TBD prices, local-simulation banner |

Better Auth identity is not duplicated. `crm_organization_profile` / `crm_user_profile` hold application fields only (no extra PII, no secrets).

## Lifecycle vs billing

Lifecycle stages: `lead`, `signup`, `onboarding`, `activated`, `trial`, `customer`, `at_risk`, `past_due`, `canceled`, `churned`.

Subscription status stays on `tenant_billing`. Allowed transitions are explicit (`ALLOWED_LIFECYCLE_TRANSITIONS`). Billing may *suggest* a stage; `transitionLifecycle` must still run.

| Billing status | Typical lifecycle suggestion |
|---|---|
| `trialing` | `trial` |
| `active` (paid plan) | `customer` |
| `past_due` / `unpaid` | `past_due` |
| `canceled` | `canceled` (not immediate `churned`) |

## Activation (`activation.v1`)

Documented product-use rule, not a single hard-coded event:

1. `organization_created` is required
2. plus **any one** of: first API key, first ingested event, first intelligence view, first webhook

Version is stored on the profile when activation fires. Callers can add `activation.v2` later without rewriting history.

## Customer timeline

Bounded events: signup, organization created, onboarding completed, API key created, first ingest, first opportunity viewed, webhook created, subscription started/changed/canceled, payment failed, reactivated.

High-volume analytics events are not copied here. Payloads reject secret-like strings.

## Operator CRM

Notes, tags, and versioned segments (`segment.v1`) are operator data. Tenant `app_user` SELECT policies return no rows (`install_operator_only_rls`). Tenants cannot insert notes. Example tags are seeded and are **not** a closed list.

## Notifications and email

Channels: `in_app`, `email`, `webhook`. Categories include account, billing, security, product, market/creator/prediction/opportunity alerts, usage, and marketing.

- `account` and `security` email/in-app cannot be disabled
- Marketing defaults to opt-out and must stay opted in to send marketing templates
- In-app inbox is RLS-scoped; unread count / mark read / mark all read
- Alert **rule foundation** exists (threshold, recommendation change, price move, creator, prediction, usage, webhook failure). Customer alert UI is Phase 18
- Usage warnings at 50/80/90/100% are idempotent per organization/meter/period/threshold

`EmailProvider`: `sendTransactional`, `sendTemplate`, `healthCheck`. Local and fixture providers do not need `RESEND_API_KEY`. `ResendEmailProvider` fails closed without a key. Production auth mail still fails closed until Resend is actually configured. Templates escape HTML, include text fallbacks, and never embed API keys.

Delivery log stores template/provider/status/attempt/failure category only — not full HTML bodies.

## Billing completion

- Plan catalog + entitlements unchanged; dollar prices remain TBD
- Local simulation writes trial start/end, past-due grace, and canceled timestamps without Stripe IDs
- Checkout/Portal adapters still fail closed in `local_simulation`
- Past-due and canceled: entitlements fall back to free; customer data is **not** deleted (`retention.v1`)
- Trial duration is `TRIAL_DURATION_DAYS` (default 14). No card required for local simulation
- Customer billing page shows plan, status, trial, entitlements, usage, and TBD prices

## Customer health (`health.v1`)

Explainable components only: activation, recent activity, API usage, errors, webhook health, billing health, feature adoption. No opaque AI score.

## Admin queries

Server-side listings exist for trials, active, past due, canceled, at-risk, recent signups, inactive, tagged high usage, and stage counts. **No platform admin UI in this phase.**

## Phase 18 boundary

Do not build evidence-backed SEO content or the platform admin console here.
