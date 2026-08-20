# Phase 22 — Controlled beta readiness

Status: **READY / BLOCKED ON STAGING**

Repository support for invite-only beta, cohorts, flags, onboarding, feedback, and conservative entitlements is implemented. **External beta customers must not be onboarded until Phase 21 staging is independently hosted and verified.**

This is not a completed controlled beta.

## Flags (server-enforced)

`platform_feature_flags` keys:

- `predictions_customer_visible` (default off; hosted ignores env-only enable)
- `content_publication`
- `creator_intelligence`
- `webhooks`
- `beta_only_features`

UI hiding is not sufficient. Customer prediction nav requires entitlement **and** the platform flag in hosted runtimes.

## Invites

`beta_invitation` stores `token_hash` only. Plaintext is returned once at creation. Consume uses `app.consume_beta_invite` (`SECURITY DEFINER`, pinned `search_path`). `BETA_INVITE_ONLY=true` requires `x-beta-invite` on signup.

## Cohorts

`internal` | `alpha` | `beta_wave_1` | `beta_wave_2` on `beta_organization`. Cohorts do not weaken RLS.

## Stripe / providers

Live Stripe remains forbidden. Real TCC/YouTube/Reddit are not required; fixture/sandbox data is the beta default. Data limitations must stay visible.

## Tests

`packages/db/src/beta/beta.test.ts`, `packages/db/src/beta.pg.test.ts`, prediction flag hosted tests, beta entitlement caps.
