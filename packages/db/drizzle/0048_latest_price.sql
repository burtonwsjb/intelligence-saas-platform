-- The latest price for each printing, kept ready so the card list can filter
-- and sort by price without pricing the whole catalog on every request.
--
-- The card list's headline price is the latest valid ungraded sale from the
-- last 30 days, else the latest TCGplayer market (reference) price. Working
-- that out costs two index probes per printing (about 0.8 ms on staging,
-- 2026-11-21), which is fine for the 24 cards on a page but not for a price
-- filter or a price sort, which must price all 259k printings first (minutes).
--
-- tcg_price_latest holds one row per printing with its newest sale and its
-- newest reference price, each in the same order the explorer used (newest
-- observed_at, then id). The explorer picks between them at read time, since
-- "sale from the last 30 days" depends on the moment of the read.
-- AFTER INSERT triggers on tcg_market_snapshot and tcg_daily_price keep it
-- current, so every writer updates it with no code change. Both tables are
-- append-only for prices, so inserts are the only change to follow.
--
-- Global catalog data: no tenant rows, readable by app_user and app_worker,
-- written only through the triggers. Forward-only, idempotent.
CREATE TABLE IF NOT EXISTS "tcg_price_latest" (
  "printing_id" text PRIMARY KEY REFERENCES "tcg_printing"("id"),
  "sold_id" text,
  "sold_price" numeric(20, 8),
  "sold_currency" text,
  "sold_condition" text,
  "sold_source_key" text,
  "sold_observed_at" timestamptz,
  "ref_id" text,
  "ref_price" numeric(20, 8),
  "ref_currency" text,
  "ref_condition" text,
  "ref_source_key" text,
  "ref_observed_at" timestamptz
);

-- Range filters on the reference price (nearly every headline price) can use this.
CREATE INDEX IF NOT EXISTS "tcg_price_latest_ref_idx" ON "tcg_price_latest" ("ref_currency", "ref_price");

CREATE OR REPLACE FUNCTION app.track_latest_price(
  p_printing_id text, p_kind text, p_id text, p_price numeric, p_currency text,
  p_condition text, p_source_key text, p_observed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind = 'sold' THEN
    INSERT INTO tcg_price_latest AS l (printing_id, sold_id, sold_price, sold_currency, sold_condition, sold_source_key, sold_observed_at)
    VALUES (p_printing_id, p_id, p_price, p_currency, p_condition, p_source_key, p_observed_at)
    ON CONFLICT (printing_id) DO UPDATE SET
      sold_id = EXCLUDED.sold_id, sold_price = EXCLUDED.sold_price, sold_currency = EXCLUDED.sold_currency,
      sold_condition = EXCLUDED.sold_condition, sold_source_key = EXCLUDED.sold_source_key,
      sold_observed_at = EXCLUDED.sold_observed_at
    WHERE l.sold_observed_at IS NULL
      OR (EXCLUDED.sold_observed_at, EXCLUDED.sold_id) > (l.sold_observed_at, l.sold_id);
  ELSE
    INSERT INTO tcg_price_latest AS l (printing_id, ref_id, ref_price, ref_currency, ref_condition, ref_source_key, ref_observed_at)
    VALUES (p_printing_id, p_id, p_price, p_currency, p_condition, p_source_key, p_observed_at)
    ON CONFLICT (printing_id) DO UPDATE SET
      ref_id = EXCLUDED.ref_id, ref_price = EXCLUDED.ref_price, ref_currency = EXCLUDED.ref_currency,
      ref_condition = EXCLUDED.ref_condition, ref_source_key = EXCLUDED.ref_source_key,
      ref_observed_at = EXCLUDED.ref_observed_at
    WHERE l.ref_observed_at IS NULL
      OR (EXCLUDED.ref_observed_at, EXCLUDED.ref_id) > (l.ref_observed_at, l.ref_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.track_latest_price_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.price IS NOT NULL AND NEW.outlier_flag = FALSE AND NEW.grading_company IS NULL
     AND NEW.price_type IN ('sold', 'reference') THEN
    PERFORM app.track_latest_price(NEW.printing_id, NEW.price_type, NEW.id, NEW.price, NEW.currency,
      NEW.condition, NEW.source_key, NEW.observed_at);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app.track_latest_price_daily()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same shape tcg_market_price_all gives a slim daily row (migration 0045).
  IF NEW.market IS NOT NULL THEN
    PERFORM app.track_latest_price(NEW.printing_id, 'reference',
      'tdp_' || NEW.printing_id || '_' || to_char(NEW.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      NEW.market::numeric(20, 8), 'USD', 'unknown', 'tcgplayer', NEW.observed_at);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tcg_market_snapshot_track_latest_price ON "tcg_market_snapshot";
CREATE TRIGGER tcg_market_snapshot_track_latest_price
  AFTER INSERT ON "tcg_market_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.track_latest_price_snapshot();

DROP TRIGGER IF EXISTS tcg_daily_price_track_latest_price ON "tcg_daily_price";
CREATE TRIGGER tcg_daily_price_track_latest_price
  AFTER INSERT ON "tcg_daily_price"
  FOR EACH ROW EXECUTE FUNCTION app.track_latest_price_daily();

-- Backfill from the existing history: two index probes per printing (about
-- 3-4 minutes for 259k printings on staging). The migration runs in one
-- transaction and CREATE TRIGGER holds off concurrent price inserts until it
-- commits, so no price lands between the backfill and the triggers.
INSERT INTO tcg_price_latest AS l (
  printing_id, sold_id, sold_price, sold_currency, sold_condition, sold_source_key, sold_observed_at,
  ref_id, ref_price, ref_currency, ref_condition, ref_source_key, ref_observed_at
)
SELECT p.id, so.id, so.price, so.currency, so.condition, so.source_key, so.observed_at,
  re.id, re.price, re.currency, re.condition, re.source_key, re.observed_at
FROM tcg_printing p
LEFT JOIN LATERAL (
  SELECT ms.id, ms.price, ms.currency, ms.condition, ms.source_key, ms.observed_at
  FROM tcg_market_snapshot ms
  WHERE ms.printing_id = p.id AND ms.price_type = 'sold' AND ms.price IS NOT NULL
    AND ms.outlier_flag = FALSE AND ms.grading_company IS NULL
  ORDER BY ms.observed_at DESC, ms.id DESC LIMIT 1
) so ON TRUE
LEFT JOIN LATERAL (
  SELECT ms.id, ms.price, ms.currency, ms.condition, ms.source_key, ms.observed_at
  FROM tcg_market_price_all ms
  WHERE ms.printing_id = p.id AND ms.price_type = 'reference' AND ms.price IS NOT NULL
    AND ms.outlier_flag = FALSE AND ms.grading_company IS NULL
  ORDER BY ms.observed_at DESC, ms.id DESC LIMIT 1
) re ON TRUE
WHERE so.id IS NOT NULL OR re.id IS NOT NULL
ON CONFLICT (printing_id) DO NOTHING;

ANALYZE "tcg_price_latest";

DO $$
BEGIN
  GRANT SELECT ON TABLE "tcg_price_latest" TO app_user, app_worker;
  REVOKE INSERT, UPDATE, DELETE ON TABLE "tcg_price_latest" FROM app_user, app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
