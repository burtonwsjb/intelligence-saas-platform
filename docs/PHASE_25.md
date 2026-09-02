# Phase 25 — Platform reliability, operations, and failure recovery

Status: **implemented in-repo**. Hosted staging verification of worker heartbeat identity remains a user action after return. This phase does not deploy, apply hosted migrations, enable live providers, or change secrets.

## Worker lifecycle

`apps/worker` now treats Railway SIGTERM/SIGINT as a drain, not an immediate exit.

- Startup still writes a one-time sanitized heartbeat.
- Shutdown clears scheduler/outbox intervals, waits for the in-flight BullMQ job, closes the queue, quits Redis, and ends the owned Postgres pool.
- A force-exit timer (25s) covers a hung drain inside Railway’s ~30s SIGTERM window.
- `WORKER_HEALTH_PORT` returns 200 while running and 503 while shutting down. The payload has no secrets.

## Queue durability

| Concern | Behavior |
|---|---|
| Idempotency | Outbox id is the BullMQ `jobId`; processed source/platform rows short-circuit duplicates |
| Retries | 5 attempts, exponential backoff from 2s |
| Poison / unrecoverable | `UnrecoverableJobError` → permanent failure + inspectable BullMQ failed set (`removeOnFail: false`) |
| Timeout | 90s job deadline; lock 120s; stalled scan 30s; max 2 stalls |
| Replay | Deterministic platform outbox ids; `onConflictDoNothing` |

## Provider scheduler

Due-ness is a pure decision (`decideProviderSyncDue`) covering disabled, paused, interval, `Retry-After`, and exhausted rate-limit windows. Leases compare and extend with database `now()` so worker clock skew cannot overlap two syncs. Restart recovery reuses the same time-bucket job id.

## Outbox

Tenant and platform outbox remain at-least-once. After 20 publish failures a row is dead-lettered (`status=failed`) and drops out of `list_pending_*`. Replay of a completed/pending id is a no-op. Failed platform jobs can still be retried by the existing admin retry helper.

## Database and Redis recovery

Postgres connections set connect/idle/lifetime limits for Neon suspend/resume. Transient Neon/Postgres codes (`57P01`, `08006`, `40001`, aborted `25P02`, timeouts) are classified and retried in helper form. Redis reconnects on READONLY/LOADING, uses a command timeout, and quit-or-disconnects on shutdown so loops do not hang silently.

## Health

`collectSystemHealth` is `health.v3`: overall `healthy | degraded | stale | missing | failed`, queue health, and operator guidance with no secrets. Admin Health renders the overall state first.

## Validation

Unit tests cover error classification, due-ness, leases, outbox dead-letter, shutdown latch, and health rollup. No new hosted migration was created.

## Hosted actions still required

- Do not continue worker heartbeat identity troubleshooting in this sprint.
- Apply no new migrations (none were added).
- Do not enable live providers.
