-- Sealed products (booster boxes, elite trainer boxes, ...) are market assets
-- tied to a set. They reuse the asset pipeline: posts that name them feed
-- sentiment and calls, and calls are scored on their price series.
ALTER TABLE "market_asset" DROP CONSTRAINT IF EXISTS market_asset_kind_chk;
ALTER TABLE "market_asset" ADD CONSTRAINT market_asset_kind_chk
  CHECK ("kind" IN ('crypto', 'stock', 'commodity', 'index', 'sealed', 'other'));

ALTER TABLE "market_asset" ADD COLUMN IF NOT EXISTS "game_key" text REFERENCES "tcg_game"("game_key");
ALTER TABLE "market_asset" ADD COLUMN IF NOT EXISTS "set_id" text REFERENCES "tcg_set"("id");
ALTER TABLE "market_asset" ADD COLUMN IF NOT EXISTS "product_type" text;
ALTER TABLE "market_asset" ADD COLUMN IF NOT EXISTS "language_code" text REFERENCES "tcg_language"("language_code");

DO $$
BEGIN
  ALTER TABLE "market_asset" ADD CONSTRAINT market_asset_sealed_chk CHECK (
    ("kind" = 'sealed') = ("set_id" IS NOT NULL AND "product_type" IS NOT NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END;
$$;
DO $$
BEGIN
  ALTER TABLE "market_asset" ADD CONSTRAINT market_asset_product_type_chk CHECK (
    "product_type" IS NULL OR "product_type" IN (
      'booster_pack', 'booster_bundle', 'booster_box', 'elite_trainer_box', 'collection', 'tin', 'other'
    )
  );
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS market_asset_set_idx ON "market_asset" ("set_id") WHERE "set_id" IS NOT NULL;
