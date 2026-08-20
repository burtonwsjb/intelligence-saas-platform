# Load testing

Do not point this harness at production or any shared customer environment.

## CI / local bounded smoke

`apps/api/src/load.smoke.test.ts` (runs with `pnpm test`):

- 25 sequential `GET /health` requests
- `GET /ready` with an injected database ping
- Asserts security headers and no credential leakage

## Local disposable profile (manual)

Prerequisites: `docker compose` Postgres + Redis, migrated database, `pnpm --filter @isp/api start`.

Profile (document only; run when iterating locally):

| Path | Concurrency | Duration | Notes |
|---|---|---|---|
| GET /health | 20 | 30s | liveness |
| GET /v1/me | 5 | 30s | machine auth |
| commercial read (markets/opportunities as entitled) | 5 | 30s | watch DB CPU |
| POST /v1/events | 10 | 60s | unique idempotency keys; worker must drain |
| webhook create/list | 2 | 30s | SSRF still applied |

Success means the worker consumes the outbox, not only HTTP 202. If jobs remain `pending`, the run failed.

Heavy load is **not** in GitHub Actions (`validate` stays unit/isolation/integration/build).

## Worker failure expectations

| Scenario | Expected |
|---|---|
| Redis down at ingest | HTTP 202; outbox durable; publish skipped |
| Redis down at worker start | process stays retrying or exits; no silent success |
| DB down at worker job | BullMQ retry; outbox remains |
| Malformed job | `UnrecoverableError`; marked failed |
| Worker restart | in-flight jobs retry; outbox sweep resumes |
| Duplicate idempotency | 409 or original event, no double kernel write |

## Chaos (local)

- API process starts without Redis: `/health` is ok; `/ready` redis=error or skipped; ingest still 202.
- Worker without `DATABASE_URL`: first job fails; process should not pretend success.
- Recovery: restoring Redis/DB allows outbox sweep to publish and process remaining jobs.
