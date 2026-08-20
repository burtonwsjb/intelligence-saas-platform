# Environment matrix

`ISP_ENV` is `local` | `test` | `staging` | `production`.

If `ISP_ENV` is unset and `NODE_ENV=production`, the runtime is **production**. Staging on Vercel/Railway (which set `NODE_ENV=production`) **must** set `ISP_ENV=staging`.

No hosted environment may fall back to local billing simulation, `PLATFORM_ADMIN_EMAILS`, loopback `APP_URL`, or test queue prefixes.

| Concern | local | test | staging | production |
|---|---|---|---|---|
| Database | Docker Postgres; `DATABASE_URL` may be superuser locally | CI disposable Postgres | Neon; `app_user` pooled; migrations unpooled `DATABASE_ADMIN_URL` | Same pattern, separate project |
| Worker DB | `DATABASE_URL` or `WORKER_DATABASE_URL` | same | `WORKER_DATABASE_URL` as `app_worker` | `app_worker` |
| Redis | `redis://localhost:6379` | CI Redis | Managed Redis; `rediss://` preferred | `rediss://` unless `REDIS_TLS=optional` on a private network |
| Auth cookies | insecure HTTP ok | test | Secure + HTTPS `APP_URL` | Secure + HTTPS |
| Billing | `local_simulation` default | simulation | `stripe_test` only | `stripe_test` until live is explicitly authorized (still forbidden in code) |
| Email | file/log/fixture | fixture | `AUTH_EMAIL_MODE=resend` | Resend |
| Webhooks | public URLs only; SSRF on | same | same; tenant HTTPS recommended | same |
| Predictions | env flag may enable | tests | platform flag **required** | platform flag **required** |
| Content generation | local fixtures | tests | beta caps disable generation | legal/ops gated |
| Admin access | optional `PLATFORM_ADMIN_EMAILS` | tests | `platform_admins` only | `platform_admins` only |
| Logging | JSON structured | JSON | JSON, no secrets | JSON, no secrets |
| Queue prefix | `local` default | `ci` / `test` | `staging` (not `local`) | `production` (must not contain `staging`) |
| Public URLs | `http://localhost:3000` | n/a | `https://…` non-loopback | `https://…` non-loopback, not a staging host |
| CORS / trusted origins | `APP_URL` | tests | exact staging web origin | exact production web origin |

## Process env groups

| Process | Required (hosted) | Must never reach the client bundle |
|---|---|---|
| Web public | `APP_URL`, `API_URL` (if used) | secrets |
| Web server | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `API_KEY_PEPPER` (if issuing keys), `DATABASE_ADMIN_URL` + `APP_ADMIN_PASSWORD` for `/admin` | all of the above |
| API | `DATABASE_URL`, `REDIS_URL`, `API_KEY_PEPPER`, `APP_URL`, `PORT` from the platform | same |
| Worker | `WORKER_DATABASE_URL` or `DATABASE_URL`, `REDIS_URL`, `QUEUE_PREFIX` | same |
| Migrate/bootstrap | `DATABASE_ADMIN_URL` (unpooled), `APP_*_PASSWORD` | same |

`assertHostedSecrets()` runs at API/worker/web auth startup.
