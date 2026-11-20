-- Price currencies for the card list's currency filter.
--
-- The card list asked for the distinct currencies in tcg_market_snapshot on
-- every load. With no index that read the whole table (12M rows, 20 GB on
-- staging): 55s per page load (2026-11-20). With this index the explorer
-- walks the few distinct values directly (one index probe per currency).
--
-- On a large live database, create it first with CREATE INDEX CONCURRENTLY
-- (same name) so writes are never blocked; this file then does nothing.
-- Forward-only, idempotent.
CREATE INDEX IF NOT EXISTS "tcg_market_snapshot_currency_idx"
  ON "tcg_market_snapshot" ("currency", "price_type");
