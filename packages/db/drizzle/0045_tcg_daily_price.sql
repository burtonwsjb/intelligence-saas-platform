-- Slim daily TCGplayer market prices for every game, read from tcgcsv.com.
-- One small row per printing per day (about 60 bytes plus the key index),
-- instead of a full tcg_market_snapshot row plus its tcg_market_ingest
-- payload (about 3 KB). Owner decision 2026-11-20: every game, slim table.
--
-- tcg_tcgplayer_group: tcgcsv's sets (groups) per TCGplayer category, with
-- when their card list was last read and which tcgcsv build their price
-- file was last pulled for.
--
-- tcg_tcgplayer_link: which TCGplayer product and price sub-type a printing
-- is (from earlier TCG Card Central answers or from matching tcgcsv's card
-- lists), so the daily pull knows which price file row to read.
--
-- tcg_market_price_all: tcg_market_snapshot plus the slim rows shaped as
-- snapshot rows (source tcgplayer, reference, product level), so every price
-- reader sees both through one relation.
--
-- Global catalog-side data: no tenant rows. Written only by the worker.
-- Forward-only, idempotent.
CREATE TABLE IF NOT EXISTS "tcg_tcgplayer_group" (
  "group_id" integer PRIMARY KEY,
  "category_id" integer NOT NULL,
  "game_key" text NOT NULL,
  "name" text NOT NULL,
  "abbreviation" text,
  "modified_on" text,
  "products_scanned_at" timestamptz,
  "products_modified_on" text,
  "prices_build" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tcg_tcgplayer_group_game_idx" ON "tcg_tcgplayer_group" ("game_key", "category_id");

CREATE TABLE IF NOT EXISTS "tcg_tcgplayer_link" (
  "printing_id" text PRIMARY KEY REFERENCES "tcg_printing"("id"),
  "category_id" integer,
  "group_id" integer,
  "group_name" text,
  "product_id" integer NOT NULL,
  "sub_type" text NOT NULL,
  "method" text NOT NULL,
  "matched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_tcgplayer_link_method_chk CHECK ("method" IN ('tcc_answer', 'number_match', 'manual'))
);

CREATE INDEX IF NOT EXISTS "tcg_tcgplayer_link_group_idx" ON "tcg_tcgplayer_link" ("category_id", "group_id");

-- observed_at is always 20:00 UTC of the price day (about when tcgcsv
-- publishes its daily build), so (printing_id, observed_at) is one row per
-- printing and day, and price readers' "latest before now" walks this key.
CREATE TABLE IF NOT EXISTS "tcg_daily_price" (
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "observed_at" timestamptz NOT NULL,
  "market" numeric(12, 2) NOT NULL,
  "low" numeric(12, 2),
  "mid" numeric(12, 2),
  "high" numeric(12, 2),
  "source" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("printing_id", "observed_at"),
  CONSTRAINT tcg_daily_price_market_chk CHECK ("market" > 0),
  CONSTRAINT tcg_daily_price_source_chk CHECK ("source" IN ('daily', 'archive')),
  CONSTRAINT tcg_daily_price_time_chk CHECK ("observed_at" = date_trunc('day', "observed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '20 hours')
);

CREATE OR REPLACE VIEW "tcg_market_price_all" AS
SELECT
  "id", "printing_id", "source_key", "market_type", "price_type", "observed_at", "currency", "condition",
  "grading_company", "grade_label", "grade_numeric", "certification_number", "price", "quantity",
  "listing_count", "sales_count", "volume_value", "low_price", "high_price", "median_price", "average_price",
  "bid_count", "seller_count", "shipping_amount", "tax_amount", "fee_amount", "window_seconds",
  "aggregation_kind", "source_record_id", "fingerprint", "source_reference", "quality_label", "outlier_flag",
  "outlier_reason", "outlier_algorithm_version", "attributes", "created_at"
FROM "tcg_market_snapshot"
UNION ALL
SELECT
  'tdp_' || d."printing_id" || '_' || to_char(d."observed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  d."printing_id",
  'tcgplayer'::text,
  'market_price'::text,
  'reference'::text,
  d."observed_at",
  'USD'::text,
  'unknown'::text,
  NULL::text,
  NULL::text,
  NULL::numeric(8, 2),
  NULL::text,
  d."market"::numeric(20, 8),
  NULL::integer,
  NULL::integer,
  NULL::integer,
  NULL::numeric(20, 8),
  d."low"::numeric(20, 8),
  d."high"::numeric(20, 8),
  d."mid"::numeric(20, 8),
  NULL::numeric(20, 8),
  NULL::integer,
  NULL::integer,
  NULL::numeric(20, 8),
  NULL::numeric(20, 8),
  NULL::numeric(20, 8),
  NULL::integer,
  'event'::text,
  'tcgcsv:daily:' || d."printing_id" || ':' || to_char(d."observed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  ''::text,
  NULL::text,
  'normal'::text,
  false,
  NULL::text,
  NULL::text,
  jsonb_build_object('price_source', 'tcgcsv_' || d."source"),
  d."created_at"
FROM "tcg_daily_price" d;

DO $$
BEGIN
  GRANT SELECT ON TABLE "tcg_tcgplayer_group", "tcg_tcgplayer_link", "tcg_daily_price", "tcg_market_price_all" TO app_user, app_worker;
  GRANT INSERT, UPDATE ON TABLE "tcg_tcgplayer_group", "tcg_tcgplayer_link" TO app_worker;
  GRANT INSERT ON TABLE "tcg_daily_price" TO app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;

-- Printings TCG Card Central already matched to a TCGplayer product keep that
-- match (latest answer wins), so the daily pull starts with them.
INSERT INTO "tcg_tcgplayer_link" ("printing_id", "group_name", "product_id", "sub_type", "method", "matched_at")
SELECT DISTINCT ON (s."printing_id")
  s."printing_id",
  nullif(s."attributes"->>'tcgplayer_group_name', ''),
  (s."attributes"->>'tcgplayer_product_id')::integer,
  s."attributes"->>'tcgplayer_sub_type',
  'tcc_answer',
  s."observed_at"
FROM "tcg_market_snapshot" s
WHERE s."source_key" = 'tcg_card_central'
  AND s."price_type" = 'reference'
  AND s."attributes"->>'tcgplayer_product_id' ~ '^[0-9]{1,9}$'
  AND coalesce(s."attributes"->>'tcgplayer_sub_type', '') <> ''
ORDER BY s."printing_id", s."observed_at" DESC
ON CONFLICT ("printing_id") DO NOTHING;
