# Phase 04 — Stripe test mode, entitlements, API keys, and usage stubs

Status: **implemented**. Hosted Stripe Checkout/Portal against real test products is **deferred**. Phase 05 has **not** started.

Stripe live mode is forbidden. No production prices, no Neon/Vercel/Railway, no Redis/BullMQ, no TCG ingest.

## Billing architecture

Stripe is the payment processor. The application database is the authorization source.

| Stripe | Application |
|---|---|
| Customer, Checkout, Portal, subscription, invoice events | `tenant_billing`, `plan`, `plan_entitlement`, overrides |
| Event id | `stripe_event` via `app.claim_stripe_event` |

Feature access never calls Stripe on the request path. Webhooks update normalized state. Redirect success is not billing truth.

## Billing modes

| Mode | When | Stripe network | Secrets / price IDs | Checkout / Portal |
|---|---|---|---|---|
| `local_simulation` | Default when `NODE_ENV` is not `production` and `BILLING_MODE` is unset or `local_simulation` | none | not required | fail closed |
| `stripe_test` | `BILLING_MODE=stripe_test`, or production until live is explicitly allowed | Stripe test API only | `sk_test_...`, `whsec_...`, `price_...` | enabled if configured |
| `stripe_live` | never | forbidden | `sk_live_` rejected | forbidden |

`BILLING_MODE=local_simulation` in production throws. `BILLING_MODE=stripe_live` always throws.

Local simulation writes the same normalized `tenant_billing.plan_key` / `status` fields a webhook would write. Entitlement resolution is identical. Stripe customer/subscription/price IDs are left null. Do not store fake `cus_` / `sub_` / `price_` values as provider IDs.

## Local billing simulation

Helper (not a public HTTP API, not a tenant action):

```ts
import { simulateTenantSubscription } from "@isp/billing/simulation";

await withOrganizationContext(db, { organizationId, userId }, (scoped) =>
  simulateTenantSubscription(scoped, {
    organizationId,
    fixture: "active", // free | trialing | active | past_due | canceled
    env: process.env,
  }),
);
```

Fixtures live in `@isp/billing` `LOCAL_BILLING_FIXTURES`. Use only on disposable local/test databases.

Unavailable when:

- `NODE_ENV=production`
- `BILLING_MODE` is not `local_simulation`
- the active tenant context does not match `organizationId`

It does not bypass RLS. It is not exposed on `/app` or `/v1`.

## Stripe test-mode flow (deferred)

1. Owner/billing role starts Checkout (`/app/billing`).
2. Server creates or reuses one Stripe Customer for the tenant.
3. Checkout session includes `metadata.organization_id`.
4. User returns to `/app/billing`. UI does not mark the plan paid.
5. `POST /webhooks/stripe` on `apps/api` verifies the signature and updates `tenant_billing`.

Live secrets (`sk_live_...`) are rejected.

## Subscription state mapping

| Status | Paid entitlements |
|---|---|
| `trialing`, `active` | yes (stored plan) |
| `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`, `none` | no — effective plan is `free` |

Failed payment does not grant paid access. Cancellation does not delete tenant data. `tenant.status` stays independent of subscription status.

## Entitlement model

Central resolver: plan defaults + optional tenant override. Unknown keys fail closed (`enabled: false`, limit `0`).

Helpers: `hasFeature`, `getLimit`, `assertFeature`, `assertWithinLimit`.

## Plan catalog

Data-driven rows in `plan` / `plan_entitlement`: `free`, `starter`, `growth`, `scale`.

No dollar prices are stored. Stripe Price IDs come from local env when Checkout is used:

- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_SCALE`

These are identifiers, not secrets. They are empty in `.env.example`. Checkout and Portal **fail closed** until Stripe test mode is configured later. Local development does not require them.

## Stripe customer mapping

One Stripe Customer per tenant on `tenant_billing.stripe_customer_id`.

Webhook tenant resolution:

1. Look up organization by `stripe_customer_id` (`app.lookup_organization_by_stripe_customer`).
2. If event metadata includes `organization_id`, it must match.
3. Metadata alone is not enough.

## Webhook idempotency

`app.claim_stripe_event` inserts the Stripe event id once. Retries return duplicate and do not apply side effects again. Unknown event types are ignored after the claim.

Handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.

## API key format

`isp_test_<8-hex-prefix>_<secret>`

Example shape only: `isp_test_ab12cd34_<random>`. Production/live keys are not issued.

Stored: `prefix`, HMAC-SHA256(`API_KEY_PEPPER`, full key). Plaintext is returned once at creation and never stored.

## API key hashing

- HMAC-SHA256 with `API_KEY_PEPPER` (min 16 chars)
- Constant-time compare of hex hashes
- Missing pepper fails closed

## Scopes

Issuable now: `ingest:write`, `decisions:read`.

Known later (fail closed if used as required scope before routes exist): `receipts:write`, `cards:read`, `prices:read`, `markets:read`, `signals:read`, `creators:read`, `predictions:read`, `opportunities:read`, `content:read`, `webhooks:manage`.

Unknown scopes cannot be assigned.

## RBAC

| Role | API keys | Billing |
|---|---|---|
| owner | yes | yes |
| admin | yes | no |
| developer | yes | no |
| billing | no | yes |
| analyst / marketing / viewer | no | no |

## API auth middleware

Hono `Authorization: Bearer` on `/v1/*` only. `/health` is open. `/webhooks/stripe` uses Stripe signatures, not API keys.

Middleware: parse bearer, lookup prefix, verify hash, status, expiry, bind tenant from the key, bind scopes, require `tenant.status = active`, touch `last_used_at`. Request parameters cannot override tenant.

Error semantics:

| HTTP | Code | Meaning |
|---|---|---|
| 401 | `unauthorized` | missing/invalid/revoked/expired key |
| 403 | `scope_denied` / `tenant_suspended` | scope or inactive tenant |
| 402 | `entitlement_denied` | plan feature off |
| 429 | `quota_exceeded` | monthly usage at or over limit |

## Machine tenant context

`withMachineContext` sets:

- `app.current_organization_id`
- `app.current_principal_type = machine`
- `app.current_api_key_id`

Policies require the key row to belong to that organization and be active. Browser isolation still requires membership. System context (`principal_type = system`) is only for verified webhook updates.

Prefix lookup uses `app.lookup_api_key_by_prefix` (`SECURITY DEFINER`, pinned `search_path`, prefix-only, no arbitrary SQL) because auth happens before tenant context exists.

`app.has_machine_principal()` is also `SECURITY DEFINER` so it can validate the current key row without re-entering `api_key` RLS (which would recurse).

Those definers are owned by `app_migrate` (`NOBYPASSRLS`). `tenant_billing` and `api_key` use `FORCE ROW LEVEL SECURITY`, so a `TO app_migrate` SELECT policy (`USING (true)`) exists only so prefix/customer mapping can see the target row. `app_user` still uses tenant policies and cannot hop.

## Usage meter model

Internal system of record. Not synced to Stripe Billing Meters (Phase 16).

Meters: `api.reads`, `ingest.events`, `decisions.generated`.

`usage_event` + monthly `usage_month` aggregate. Duplicate `idempotency_key` per tenant is ignored.

## Quota model

Database-backed calendar-month totals. No Redis. Quota enforcement uses application aggregates, not Stripe.

`/v1/me` (scope `decisions:read`) records `api.reads` after quota check. Test/internal only.

## Local test setup

```bash
pnpm test
pnpm test:isolation   # DATABASE_ADMIN_URL + Docker Postgres
```

Default `BILLING_MODE` is local simulation. No Stripe secret, webhook secret, or price ID is required.

To simulate a subscription in a disposable database, call `@isp/billing/simulation` inside `withOrganizationContext` (see above). Do not add a public route for this.

## Stripe dashboard setup (deferred)

Hosted Checkout/Portal against real Stripe test products is **not required for Phase 04**. When that work is resumed:

1. Dashboard → toggle **Test mode** on
2. Products: `ISP Starter`, `ISP Growth`, `ISP Scale`
3. Price type: recurring, monthly, flat (not metered)
4. Usage/metered prices: **not needed then unless metering is in scope**
5. Copy `price_...` ids into local `STRIPE_PRICE_*`
6. Developers → Webhooks (test) or Stripe CLI for `whsec_...`
7. Customer Portal settings must be enabled in test mode before Portal sessions work
8. Set `BILLING_MODE=stripe_test` plus `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` in untracked `.env`

Do not paste secret keys into chat. Price IDs may be shared.

## Security decisions

- Local simulation cannot run in production and is not a public API
- Webhook signature verification is unchanged in `stripe_test` (never skipped)
- No publishable key (hosted Checkout, no card collection in-app)- No Stripe or API secrets in git
- Append-only audit: `api_key.created|revoked|rotated`, `subscription.checkout_started|changed`, `billing.portal_opened`
- `stripe_event` is not readable by `app_user`; claim function only

## Known limitations

- Hosted Stripe Checkout and Customer Portal are **deferred** (fail closed)
- Stripe meters are not wired
- `/v1/events` ingest and commercial TCG routes are not implemented
- Portal configuration is a Stripe Dashboard setting when that work resumes

## Remaining Stripe work (later, not Phase 05)

- Create Stripe **test-mode** products/prices
- Set local `STRIPE_PRICE_*`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Set `BILLING_MODE=stripe_test`
- Enable Customer Portal in the Stripe test Dashboard
- Exercise hosted Checkout/Portal and signed webhook delivery
- Never use live mode until an explicit later go-ahead

## Phase 05 handoff

Phase 05 may add Redis/BullMQ and generic ingest. Keep API keys tenant-bound and do not move quota enforcement onto Stripe aggregation. Do not start Phase 05 until explicitly instructed.
