# Production smoke (do not run against production now)

Automated later; today this is a checklist/script target.

1. `/` home
2. Signup (or invite)
3. Login
4. Organization
5. API key create (copy once)
6. `GET /health` and `GET /ready` on API
7. Machine `GET /v1/me`
8. Market/opportunity read
9. Webhook create (public URL)
10. Notification preference
11. `/admin` denied for normal tenant; granted operator
12. Predictions hidden unless flag+entitlement

Script placeholder: `scripts/production-smoke.md` is this file. Do not add a runner that defaults to a production URL.
