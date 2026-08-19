# Phase 05 — Queue, worker, generic ingest, job durability, and retries

Status: **implemented**. Phase 06 is complete; see [PHASE_06.md](PHASE_06.md). Phase 07 has **not** started.

No cloud Redis, Neon production, Railway, Vercel, Stripe live Checkout, TCG identity, TCC, market data, YouTube/Reddit, creator intelligence, or prediction engine.

## Redis / BullMQ architecture

`packages/queue` (`@isp/queue`) owns Redis connections, queue names, typed job envelopes, retry defaults, and outbox publish helpers. Apps must not invent raw queue names.

| Piece | Owner |
|---|---|
| Redis URL | `REDIS_URL` (server-side only; never browser) |
| Queue name | `isp-{env}-ingest` |
| Job type | `source_event.normalize` only |
| Envelope | Zod `jobEnvelopeSchema` version `1` |
| Retries | 5 attempts, exponential backoff starting at 2000ms |
| Failed jobs | `removeOnFail: false` so BullMQ remains inspectable |

Missing `REDIS_URL` throws `MissingRedisUrlError`. An unreachable Redis throws `QueueUnavailableError`. Queue-dependent functions fail clearly; they do not drop accepted work.

## Queue names and prefix strategy

BullMQ 5 forbids `:` in queue names, so the prefix uses hyphens.

`QUEUE_PREFIX` may override the environment segment when it matches `^[a-z0-9_-]{1,32}$`. Otherwise:

| `NODE_ENV` | Queue |
|---|---|
| `test` | `isp-test-ingest` |
| `staging` | `isp-staging-ingest` |
| `production` | `isp-production-ingest` |
| anything else | `isp-local-ingest` |

CI sets `QUEUE_PREFIX=ci` so GitHub Actions does not collide with a developer laptop. Prefixes are not secrets.

BullMQ still manages Redis keys under the queue name. Tenant isolation is **not** implemented as a Redis ACL; it is enforced in Postgres RLS and in the job envelope.

## Job envelope

Every BullMQ payload is a normalized envelope. Arbitrary request JSON is never enqueued.

```json
{
  "job_version": 1,
  "job_type": "source_event.normalize",
  "job_id": "<outbox_job.id>",
  "organization_id": "<api key tenant>",
  "source_event_id": "<source_event.id>",
  "created_at": "2026-08-16T00:00:00.000Z",
  "request_id": "optional-correlation-id"
}
```

Unknown `job_type` or invalid schema throws `UnrecoverableJobError` (fail closed).

## Source event schema

`source_event` is the durable ingest boundary. It is not the Phase 06 observation/signal model.

| Column | Role |
|---|---|
| `id` | Public `event_id` |
| `organization_id` | Tenant from the API key |
| `event_type` | Generic dotted type (`pricing.snapshot`) |
| `occurred_at` / `received_at` | Event time vs accept time |
| `idempotency_key` | Tenant-scoped unique |
| `fingerprint` | SHA-256 of canonical body (excludes the key) |
| `entity` / `metrics` / `payload` | Untrusted JSON data |
| `processing_status` | `received` → `queued` → `processing` → `processed` \| `failed` |
| `failure_category` | `transient` \| `permanent` |
| `created_by_api_key_id` | Issuing key |

RLS is `FORCE`d. Inserts require an authorized principal and an active tenant. The request body cannot choose another tenant.

## Outbox pattern

`source_event` and `outbox_job` are written in the same machine-context transaction **before** Redis publish.

| Column | Role |
|---|---|
| `id` | Also used as BullMQ `jobId` |
| `organization_id` | Same tenant as the source event |
| `job_type` | Envelope type |
| `payload` | Validated envelope JSON |
| `status` | `pending` \| `published` \| `failed` |
| `attempts` / `available_at` / `last_error` | Publish retry |
| `published_at` | Set when Redis accept is confirmed |

If Redis is down after commit, the API still returns `202`. The outbox row stays `pending` with a safe truncated error. `apps/worker` sweeps `app.list_pending_outbox` every 5 seconds and publishes.

### Duplicate publisher behavior

BullMQ `jobId` equals `outbox_job.id`.

1. Publish succeeds, then the process crashes before `published` is stored: retry sees “job already exists”, treats that as success, and marks the outbox published.
2. The worker may see the job once or retry after a crash. Processing is idempotent: a `processed` source event is a no-op.
3. Replay of the same HTTP idempotency key does **not** insert a second outbox row.

## Idempotency

`POST /v1/events` requires `idempotency_key` (`8–128` chars, `[A-Za-z0-9_.:-]`). Uniqueness is `(organization_id, idempotency_key)`.

| Replay | Result |
|---|---|
| Same key, same fingerprint | `202` with the original `event_id`; no new row, usage, or job |
| Same key, different body | `409 idempotency_conflict` |
| Different key | New accepted event |

Caller-supplied `x-request-id` is correlation only. It is never a uniqueness or security key. Invalid values are replaced with a generated UUID.

## Ingest API

`POST /v1/events`

- Bearer API key, scope `ingest:write`
- Active tenant required (`403 tenant_suspended` if not)
- Entitlement `api_requests_per_month` (`402` if disabled)
- Quota meter `ingest.events` (`429` if exceeded)
- Body cap **65536 bytes** (`413`)
- `event_type` must match `^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$`
- `occurred_at` must be ISO-8601 and not more than 24 hours in the future
- Response `202 { event_id, accepted: true }` plus `x-request-id`

Payload is stored as data. Phase 05 does not execute it, fetch URLs from it, render it as HTML, or send it to an LLM.

## Status transitions

Illegal transitions throw `IllegalSourceEventTransitionError`.

```text
received → queued | processing | failed
queued → processing | failed
processing → processed | failed | processing
processed → processed
failed → failed
```

`processed` and `failed` are terminal except for no-op self-transitions used by idempotent workers.

## Retry policy

| Class | Examples | Behavior |
|---|---|---|
| Transient | Redis/network, temporary DB | BullMQ retries, max 5, exponential backoff 2s, 4s, 8s, 16s |
| Permanent | Invalid envelope, unknown job type, missing source event, tenant mismatch, inactive tenant | `UnrecoverableError`; not retried |

Publish failures leave the outbox `pending` and delay `available_at` by 5 seconds.

## Failed-job handling

- BullMQ failed jobs are retained (`removeOnFail: false`).
- Postgres stores `processing_status=failed`, `failure_category`, and a truncated safe `failure_message`.
- `getIngestJobStatus` in `@isp/queue` reads source-event and outbox rows. No admin UI.

## Tenant security

- Tenant comes from the API key, not the body.
- Worker `organization_id` must match the durable source event. A mismatch or a missing event in that tenant is a permanent failure and is audited as `job.permanent_failure` when a row can be updated.
- Cross-tenant reads of `source_event` / `outbox_job` return empty under RLS.

## Usage / quota

- Quota is checked **before** a new unique accept.
- Unique accept increments `ingest.events` once (`usage_event` idempotency `ingest:{idempotency_key}`).
- Duplicate replay does not increment.
- Failed Redis publish after accept does not increment again.
- Invalid requests (400/401/403/409/413) do not increment.
- Quota stays in Postgres. It is not moved to Redis.

## Audit vs logs

Audit (low volume): `source_event.accepted`, `job.permanent_failure`.

Structured logs (high volume): `request_id`, `job_id`, `source_event_id`, `organization_id`, `job_type`, `attempt`, `status`. Authorization headers, API key secrets, database URLs, and Redis URLs are redacted.

## Local Docker

```bash
docker compose up -d postgres redis
```

Local defaults:

- Postgres: `postgresql://isp:isp_dev_only@localhost:5432/isp`
- Redis: `redis://localhost:6379` (no password)

Then `pnpm db:migrate` and `pnpm db:bootstrap` as in Phase 03. Isolation and integration tests also accept the CI admin URL.

## CI

`.github/workflows/ci.yml` starts disposable `postgres:16-alpine` and `redis:7-alpine`. It runs install, typecheck, lint, unit tests, Postgres isolation tests, Redis+Postgres integration tests, and build. No cloud secrets and no deploy.

```bash
pnpm test:isolation
pnpm test:integration
```

Phase 05 is not considered proven by mocks alone.

## Known limitations

- Outbox sweep is a 5s interval, not a separate publisher process.
- No admin UI for dead letters.
- No cloud Redis vendor is selected (still an open architecture question).
- Generic HTTP ingest is a capability, not the commercial product.

## Phase 06 handoff

Phase 06 introduced canonical observations, signals, identifiers, and entity **framework** objects while keeping `source_event` as the ingest boundary. Jobs remain tenant-bound. TCG printing identity and TCC are still not started.
