# Phase 18 — Customer application, intelligence dashboard, and analytics UX

Status: **implemented**. Phase 19 has **not** started.

The backend intelligence objects are now reachable as a coherent customer-facing SaaS application. This is information architecture and functional workflow, not final visual polish. Local adapters remain the default. Predictions stay in shadow mode unless a tenant is entitled **and** `PREDICTIONS_CUSTOMER_VISIBLE=true`.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/dashboard/` | Identity formatting, opportunity/index queries, nav gating, prediction customer filter |
| `packages/db/drizzle/0018_phase18_dashboard.sql` | Tenant DELETE policies for webhook endpoints/deliveries |
| `apps/web/app/app/` | Authenticated application shell and product pages |
| `apps/web/components/` | Reusable identity line, sparkline, empty/locked states, printing workspace |

TCG Card Central is not used. Platform admin remains the `/admin` placeholder until Phase 20.

## Navigation (18A)

Primary nav is entitlement- and role-aware:

Overview, Opportunities, Markets, Cards, Creators (creator_analytics), Predictions (entitlement + customer flag), Indices, Alerts, API, Webhooks, Usage, Team, Billing, Settings.

Features the plan cannot access are omitted from nav. Direct URLs for locked features render a disabled state rather than data.

## Product surfaces

- **Overview** — catalog counts, top opportunities, risk alerts, recent creator calls when entitled, index movement, watch items from alert rules, usage, in-app notices.
- **Opportunities** — list and detail keep opportunity / risk / confidence / liquidity separate. Filters: game, language, set, recommendation, score/risk/liquidity. Identity always includes language and variant.
- **Markets / Cards** — games, sets, exact printings. Printing detail shows sold history, listings, spread, features, creator calls, and published predictions only when gated on.
- **Creators** — authority, trust, sample size, Wilson/Bayes accuracy, returns, early-call, specialization. Raw hit rate is not shown without `n`.
- **Predictions** — customer component disabled by default. Shadow rows are never listed.
- **Indices** — chart, return, membership, coverage, language, methodology, quality.
- **Alerts** — create / enable / disable / delete with server-side validation from Phase 17 rule types.
- **API keys** — list, create, commercial scopes, last used, expiration, revoke, rotate; secret once.
- **Webhooks** — endpoint, events, status, last delivery, failures, rotate, disable, delete. Signing secret once.
- **Usage** — period meters, plan limits, remaining quota, usage warnings.
- **Team** — invite / role change / remove. Viewer cannot manage members. Last owner cannot be removed. Not platform admin.
- **Billing** — Phase 17 page remains; local simulation labeled; no fake charges.
- **Settings** — org CRM profile, user profile, notification preferences (security/account not suppressible).

## Predictions gate

Customer forecasts require:

1. `predictions` entitlement
2. `PREDICTIONS_CUSTOMER_VISIBLE=true`

Default is off. `publishedPredictionsForCustomer` additionally drops `visibility=shadow` rows.

## Security

- Tenant RLS still scopes keys, webhooks, alerts, inbox, CRM profile, and preferences.
- Operator notes remain invisible.
- Webhook and API secrets are not re-displayed after creation.
- Exact printing identity is never collapsed to name-only.

## Tests

`packages/db/src/dashboard/dashboard.test.ts` covers identity formatting, nav gating, shadow prediction hiding, team last-owner protection, and sparkline paths. Alert validation remains in Phase 17 CRM tests. Full suite plus Next.js build must pass.

## Phase 19 boundary

Do not implement evidence packages, SEO articles, or programmatic content generation here.
