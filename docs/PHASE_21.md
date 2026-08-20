# Phase 21 — Staging, security, and load readiness

Status: **LOCAL READINESS PASS / BLOCKED ON STAGING**

This phase prepared the repository to deploy into an independent staging environment (Vercel web, Railway API, Railway worker, Neon Postgres, managed Redis). **Independent staging is not hosted yet.** Full Phase 21 cannot be marked complete until that environment exists and is verified.

Do not treat this document as production authorization. Live Stripe, real TCG Card Central production, DNS changes, and paid resources were not created.

## Local exit gate

| Item | State |
|---|---|
| Cloud-ready config (fail-closed env, Dockerfiles, Vercel/Railway manifests) | prepared |
| Neon compatibility (no superuser assumption; unpooled migrate; SSL; GRANT CONNECT skip) | audited + code |
| Redis TLS URL support, no FLUSHALL | audited |
| Migration smoke (`packages/db/src/migration.pg.test.ts`) | local/CI isolation |
| SSRF expansion | tests |
| Load smoke (`apps/api/src/load.smoke.test.ts`) | bounded, local |
| Observability (`@isp/shared` structured logs) | present |
| Staging runbook | [staging-runbook.md](./staging-runbook.md) |
| Staging independently hosted | **no** |

## Environment contract

See [environments.md](./environments.md). Hosted processes set `ISP_ENV=staging` or `ISP_ENV=production`. Missing `ISP_ENV` with `NODE_ENV=production` is treated as **production** (fail closed). There is no silent fallback from production to local billing, admin email allowlists, or localhost URLs.

## Deploy artifacts (not deployed)

- `vercel.json`, `.nvmrc` (Node 22)
- `apps/api/Dockerfile`, `apps/worker/Dockerfile`
- `deploy/staging/api.railway.toml`, `deploy/staging/worker.railway.toml`

## Health

- `GET /health` remains `{ "status": "ok" }`, unauthenticated, no internals.
- `GET /ready` checks database; Redis is informational. API ingest still accepts work when Redis is down (202 + outbox).

## Security notes

See [security/audit-findings.md](./security/audit-findings.md). SSRF now rejects dword/hex IPs, incomplete dotted names, IPv4-mapped IPv6, overlong URLs, and cross-host redirects. Webhook delivery uses `redirect: "manual"`.
