-- Assets outside trading cards (Bitcoin, Ethereum, ...) that creators make
-- calls about. A call names either a card printing or an asset, never both.
-- Asset prices are an append-only global series with source provenance; the
-- feed that fills it is disabled unless the operator turns it on.
CREATE TABLE IF NOT EXISTS "market_asset" (
  "id" text PRIMARY KEY,
  "asset_key" text NOT NULL,
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "aliases" text[] NOT NULL DEFAULT '{}',
  "quote_currency" text NOT NULL DEFAULT 'USD',
  "price_source_key" text,
  "price_source_ref" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_asset_kind_chk CHECK ("kind" IN ('crypto', 'stock', 'commodity', 'index', 'other')),
  CONSTRAINT market_asset_status_chk CHECK ("status" IN ('active', 'paused'))
);
CREATE UNIQUE INDEX IF NOT EXISTS market_asset_key_uidx ON "market_asset" ("asset_key");

CREATE TABLE IF NOT EXISTS "market_asset_price" (
  "id" text PRIMARY KEY,
  "asset_id" text NOT NULL REFERENCES "market_asset"("id"),
  "source_key" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "price" numeric(28, 10) NOT NULL,
  "currency" text NOT NULL,
  "source_reference" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_asset_price_positive_chk CHECK ("price" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS market_asset_price_point_uidx
  ON "market_asset_price" ("asset_id", "source_key", "observed_at");
CREATE INDEX IF NOT EXISTS market_asset_price_time_idx
  ON "market_asset_price" ("asset_id", "observed_at");

CREATE OR REPLACE FUNCTION app.forbid_market_asset_price_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Asset prices are append-only.';
END;
$$;

DROP TRIGGER IF EXISTS market_asset_price_immutable ON "market_asset_price";
CREATE TRIGGER market_asset_price_immutable
  BEFORE UPDATE OR DELETE ON "market_asset_price"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_market_asset_price_mutate();

ALTER TABLE "creator_call" ADD COLUMN IF NOT EXISTS "asset_id" text REFERENCES "market_asset"("id");
CREATE INDEX IF NOT EXISTS creator_call_asset_idx ON "creator_call" ("asset_id", "published_at")
  WHERE "asset_id" IS NOT NULL;
DO $$
BEGIN
  ALTER TABLE "creator_call" ADD CONSTRAINT creator_call_subject_chk CHECK (
    "asset_id" IS NULL OR ("printing_id" IS NULL AND "resolution_status" = 'asset_match')
  );
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END;
$$;

INSERT INTO "market_asset" ("id", "asset_key", "kind", "display_name", "aliases", "price_source_key", "price_source_ref")
VALUES
  ('mas_crypto_btc', 'crypto:btc', 'crypto', 'Bitcoin', ARRAY['bitcoin', 'btc'], 'coingecko', 'bitcoin'),
  ('mas_crypto_eth', 'crypto:eth', 'crypto', 'Ethereum', ARRAY['ethereum', 'eth', 'ether'], 'coingecko', 'ethereum'),
  ('mas_crypto_sol', 'crypto:sol', 'crypto', 'Solana', ARRAY['solana'], 'coingecko', 'solana')
ON CONFLICT ("asset_key") DO NOTHING;
