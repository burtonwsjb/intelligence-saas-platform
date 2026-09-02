# Phase 34 — Notifications, alerts, and webhook delivery

Status: **complete in-repo with mocked delivery**. No real external messages were sent.

## Added

Deterministic alert evaluation (`alertRuleMatches` / `dispatchMatchingAlerts`):

- Preference and required-category checks
- Prediction alerts require both `alerts` and `predictions` entitlements
- Prediction copy stays shadow / non-publication
- Email writes `email_delivery` with provider `mock`
- Webhook enqueue is idempotent per rule/event id
- Marketing remains opt-in and is not dispatched from alert rules

Existing webhook HMAC, replay window, SSRF deny list, retries, and dead-letter behavior are unchanged.
