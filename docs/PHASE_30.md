# Phase 30 — Public API production hardening

Status: **implemented in-repo**. No hosted deploy. Predictions remain shadow-gated.

## Additions

- List envelopes now include `has_more`, `limit`, and `request_id` alongside stable `next_cursor`
- Only `sort=id` is accepted (stable cursor order)
- Tenant GET `/v1/*` responses send `Cache-Control: private, no-store`
- Existing auth, scopes, quota, money major-units, OpenAPI, and webhook SSRF remain in force

## Already solid

Authentication, API-key hashing, tenant isolation, validation errors, rate limits (Phase 26), request IDs, Stripe webhook verification.
