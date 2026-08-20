# Production security checklist

Not authorized to execute in production from Mega-Phase D.

- [ ] HTTPS only on web, API, webhooks
- [ ] Secure cookies, SameSite=Lax, HttpOnly
- [ ] `trustedOrigins` / CORS allowlist = production `APP_URL` only
- [ ] RLS forced; `app_user`/`app_worker` without `BYPASSRLS`
- [ ] Distinct migrate/user/worker/admin credentials
- [ ] `platform_admins` grants; `PLATFORM_ADMIN_EMAILS` unset
- [ ] Break-glass always audited
- [ ] Secret rotation plan executed at least once in staging
- [ ] `API_KEY_PEPPER` in secret store
- [ ] Stripe live still off until explicit authorization
- [ ] Webhook HMAC + SSRF
- [ ] Email templates escaped; Resend production key
- [ ] Redis TLS (`rediss://` or documented private-network exception)
- [ ] Database TLS (`sslmode=require`)
- [ ] Provider tokens scoped and rotated
- [ ] Rate/quota limits on
- [ ] Backups/PITR confirmed on Neon plan
- [ ] Logs redacted; retention documented
