# Incident response (draft)

Severities:

- **SEV1** — auth, data isolation, or full outage; page immediately
- **SEV2** — ingest/worker backlog or partial API failure; same-day
- **SEV3** — cosmetic or single-tenant non-isolation bugs

| Scenario | First actions |
|---|---|
| Auth outage | Check `BETTER_AUTH_SECRET`/`APP_URL`; roll web; do not disable CSRF |
| DB outage | Vendor status; failover/PITR; keep API `/health` vs `/ready` distinct |
| Redis outage | Ingest still 202; drain outbox after Redis returns; scale worker |
| Queue backlog | Pause publishers if needed; increase worker concurrency carefully |
| Bad deploy | Redeploy previous image; DB forward-fix |
| Tenant isolation | Disable affected endpoints; preserve audit; do not “fix” by disabling RLS |
| API key compromise | Revoke key; rotate pepper only with planned re-issue |
| Webhook abuse | Disable endpoint; keep SSRF on |
| Billing | Stay in test; never switch live as an incident shortcut |
| Provider corruption | Quarantine ingest; do not silently rewrite history |
| Bad prediction/content | Keep shadow default; turn off `predictions_customer_visible` / content flags |
