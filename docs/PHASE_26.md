# Phase 26 — Security, authorization, RLS, and secret audit

Status: **implemented in-repo**. No hosted secrets were changed. No hosted migration was created or applied. Live providers remain disabled.

## Confirmed defects fixed

| Defect | Severity | Fix |
|---|---|---|
| API keys, webhook secrets, and beta invite tokens were placed in query strings | High | One-time httpOnly `isp_secret_flash` cookie (90s) |
| Next.js responses lacked security headers | Medium | CSP, frame denial, nosniff, referrer, permissions; HSTS when hosted |
| API keys could only be `isp_test_` | Medium | Production issues/accepts `isp_live_`; tests stay on `isp_test_` |
| Public API had no IP rate limit | Medium | 300/min IP, 60/min webhooks, failed-auth limiter |
| Auth routes had no brute-force window | Medium | 20/min per IP on sign-in/sign-up/reset |
| Login/signup returned Better Auth’s raw error text | Medium | Generic public messages (no account enumeration) |
| Beta invite failures echoed internal error text | Low | Generic route error |
| `trustedOrigins` listed only `APP_URL` | Low | Also allow `BETTER_AUTH_URL` |
| Job failure redaction missed `isp_live_` | Low | Redact both schemes |

## Already solid (unchanged)

- Better Auth email verification, secure cookies, CSRF enabled
- HMAC API-key hashing with pepper and timing-safe compare
- Tenant RLS + platform_admin grant model + audited break-glass
- Stripe webhook signature verification
- Customer webhook HMAC + replay window + SSRF deny list
- Static scan for `eval`, `dangerouslySetInnerHTML`, live Stripe keys

## Hosted actions still required

- Rotate any secret that may have appeared in staging access logs from earlier `?created=` / `?token=` redirects
- Confirm Vercel/Railway still inject CSP-compatible assets (no extra script origins)
- Do not enable live providers
