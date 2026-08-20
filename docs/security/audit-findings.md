# Security audit findings (Phase 21 local)

This is not a claim of zero vulnerabilities.

## Static review

Scanned application TypeScript for `eval`, `new Function`, `dangerouslySetInnerHTML`, disabled TLS, and live Stripe key literals. Regression: `apps/web/lib/security-scan.test.ts`.

SSRF coverage expanded in `packages/db/src/webhooks/ssrf.ts`. Default delivery fetch does not follow redirects (`safeWebhookFetch`).

## Dependency audit

Run `pnpm audit` when preparing a staging deploy. Do not blindly upgrade majors. Record the date and unresolved high/critical IDs in this file after each real audit.

At repository preparation (2026-08-19 local): `pnpm audit --prod` reported **1 moderate**:

| Severity | Package | Advisory | Notes |
|---|---|---|---|
| moderate | `esbuild` <=0.24.2 via `better-auth` → `drizzle-kit` | GHSA-67mh-4wv8-2f99 | Dev-server request issue. Not a runtime production path. Do not bump Better Auth/drizzle-kit majors solely for this. Re-audit before staging deploy. |

## Unresolved / accepted

| Severity | Item | Notes |
|---|---|---|
| info | Better Auth cookie names | Standard session cookies; secure flag on hosted |
| info | `/health` unauthenticated | Intentional; no version/secrets |
| medium (ops) | Staging not yet hosted | TLS, WAF, and vendor audits cannot be completed until accounts exist |
| accepted | Local Docker superuser | Gated off for hosted `ISP_ENV` |

## Secret scan

`.env.example` is names only. Test fixtures may contain `sk_live_example` **shapes** that the Stripe guard rejects. No production credentials belong in git.
