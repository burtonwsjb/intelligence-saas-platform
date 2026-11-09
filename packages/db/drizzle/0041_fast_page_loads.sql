-- Indexes that keep the overview, card list and admin pages fast.
--
-- 1. Headline price "latest sale" lookup. The explorer checks each card for a
--    valid ungraded sale in the last 30 days before falling back to the
--    TCGplayer market price. Sales are rare (TCC sends market prices), so that
--    check walked a month of daily rows per card through the heap: ~3ms a
--    card, 27s for the overview's featured cards on staging (2026-11-09).
--    This partial index holds only usable sales, so the check is one probe.
-- 2. Admin health counts failed market ingests. Without an index that is a
--    full scan of tcg_market_ingest (16 GB on staging); failed rows are rare,
--    so a partial index makes the count instant.
--
-- On a large live database, create these first with CREATE INDEX CONCURRENTLY
-- (same names) so writes are never blocked; this file then does nothing.
-- Forward-only, idempotent.
CREATE INDEX IF NOT EXISTS "tcg_market_snapshot_headline_sold_idx"
  ON "tcg_market_snapshot" ("printing_id", "observed_at" DESC, "id" DESC)
  WHERE "price_type" = 'sold' AND "price" IS NOT NULL
    AND "outlier_flag" = FALSE AND "grading_company" IS NULL;

CREATE INDEX IF NOT EXISTS "tcg_market_ingest_failed_idx"
  ON "tcg_market_ingest" ("id")
  WHERE "processing_status" = 'failed';
