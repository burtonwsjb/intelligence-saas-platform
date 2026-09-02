# Phase 33 — Billing, entitlements, usage, and plan safety

Status: **complete in-repo using stripe_test / local simulation only**. No live Stripe calls were made. No hosted migration.

## Confirmed defects fixed

- Stripe webhooks now write `past_due_since` / `grace_ends_at` on payment failure and clear them on recovery.
- Out-of-order Stripe events are ignored by comparing `event.created` to the last `subscription.changed` audit `stripe_created`.
- Past-due grace is an operator window only. Paid entitlements still fail closed (`effectivePlanKey` → `free`).
- Team invitations and API key creation now enforce plan limits.

## Invariants

- Billing failure never bypasses tenant RLS.
- Duplicate Stripe event IDs still short-circuit via `claimStripeEvent`.
- Predictions remain entitlement-gated and shadow.

No schema change. Event order uses existing audit metadata so hosted staging does not require a new migration before the next deploy.
