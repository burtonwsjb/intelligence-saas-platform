# Phase 35 — Performance and scale readiness

Status: **complete without premature indexes**. No hosted migration.

## Changes

- `GET /v1/cards`, `/v1/printings`, and `/v1/sets` apply filters, cursors, and `limit+1` in SQL.
- Due webhook deliveries process in batches of 50.

## Not done

- No new database indexes (existing identity/outbox indexes remain)
- No cache layer
- Hosted query plans still need a staging EXPLAIN pass
