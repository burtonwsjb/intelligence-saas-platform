-- Phase 08: TCG market-history substrate keyed by exact printing.
-- Platform-global shared facts. No tenant RLS. No real provider network calls.

CREATE TABLE IF NOT EXISTS "tcg_market_source" (
  "source_key" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "supports_sold" boolean NOT NULL DEFAULT false,
  "supports_listings" boolean NOT NULL DEFAULT false,
  "supports_volume" boolean NOT NULL DEFAULT false,
  "supports_condition" boolean NOT NULL DEFAULT true,
  "supports_grades" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "default_quality" text NOT NULL DEFAULT 'normal',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_source_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_market_source_quality_chk CHECK (
    "default_quality" IN ('verified', 'normal', 'suspect', 'outlier', 'incomplete')
  )
);

INSERT INTO "tcg_market_source" (
  "source_key", "display_name", "supports_sold", "supports_listings", "supports_volume",
  "supports_condition", "supports_grades", "status", "default_quality"
)
VALUES
  ('tcg_card_central', 'TCG Card Central', true, true, true, true, true, 'active', 'normal'),
  ('tcgplayer', 'TCGplayer', true, true, true, true, true, 'active', 'normal'),
  ('ebay', 'eBay', true, true, true, true, true, 'active', 'normal'),
  ('manual', 'Manual observation', true, false, false, true, true, 'active', 'normal'),
  ('fixture', 'Sandbox fixture', true, true, true, true, true, 'active', 'normal')
ON CONFLICT ("source_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "tcg_market_ingest" (
  "id" text PRIMARY KEY,
  "source_key" text NOT NULL REFERENCES "tcg_market_source"("source_key"),
  "source_record_id" text NOT NULL,
  "event_type" text NOT NULL,
  "fingerprint" text NOT NULL,
  "payload" jsonb NOT NULL,
  "processing_status" text NOT NULL DEFAULT 'received',
  "snapshot_id" text,
  "quarantine_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_ingest_status_chk CHECK (
    "processing_status" IN ('received', 'processed', 'quarantined', 'conflict', 'failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_market_ingest_source_record_uidx
  ON "tcg_market_ingest" ("source_key", "source_record_id");

CREATE TABLE IF NOT EXISTS "tcg_market_snapshot" (
  "id" text PRIMARY KEY,
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "source_key" text NOT NULL REFERENCES "tcg_market_source"("source_key"),
  "market_type" text NOT NULL,
  "price_type" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "currency" text NOT NULL,
  "condition" text NOT NULL,
  "grading_company" text,
  "grade_label" text,
  "grade_numeric" numeric(8, 2),
  "certification_number" text,
  "price" numeric(20, 8),
  "quantity" integer,
  "listing_count" integer,
  "sales_count" integer,
  "volume_value" numeric(20, 8),
  "low_price" numeric(20, 8),
  "high_price" numeric(20, 8),
  "median_price" numeric(20, 8),
  "average_price" numeric(20, 8),
  "bid_count" integer,
  "seller_count" integer,
  "shipping_amount" numeric(20, 8),
  "tax_amount" numeric(20, 8),
  "fee_amount" numeric(20, 8),
  "window_seconds" integer,
  "aggregation_kind" text NOT NULL DEFAULT 'event',
  "source_record_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "source_reference" text,
  "quality_label" text NOT NULL DEFAULT 'normal',
  "outlier_flag" boolean NOT NULL DEFAULT false,
  "outlier_reason" text,
  "outlier_algorithm_version" text,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_snapshot_market_type_chk CHECK (
    "market_type" IN (
      'marketplace_listing', 'marketplace_sold', 'market_price', 'direct_sale', 'manual_observation'
    )
  ),
  CONSTRAINT tcg_market_snapshot_price_type_chk CHECK (
    "price_type" IN ('asking', 'sold', 'reference', 'bid')
  ),
  CONSTRAINT tcg_market_snapshot_condition_chk CHECK (
    "condition" IN ('nm', 'lp', 'mp', 'hp', 'dmg', 'unknown')
  ),
  CONSTRAINT tcg_market_snapshot_currency_chk CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT tcg_market_snapshot_grade_co_chk CHECK (
    "grading_company" IS NULL OR "grading_company" IN ('psa', 'bgs', 'cgc', 'sgc', 'other')
  ),
  CONSTRAINT tcg_market_snapshot_quality_chk CHECK (
    "quality_label" IN ('verified', 'normal', 'suspect', 'outlier', 'incomplete')
  ),
  CONSTRAINT tcg_market_snapshot_agg_chk CHECK ("aggregation_kind" IN ('event', 'window')),
  CONSTRAINT tcg_market_snapshot_price_chk CHECK ("price" IS NULL OR "price" > 0),
  CONSTRAINT tcg_market_snapshot_qty_chk CHECK ("quantity" IS NULL OR "quantity" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_market_snapshot_source_record_uidx
  ON "tcg_market_snapshot" ("source_key", "source_record_id");
CREATE INDEX IF NOT EXISTS tcg_market_snapshot_printing_time_idx
  ON "tcg_market_snapshot" ("printing_id", "observed_at");
CREATE INDEX IF NOT EXISTS tcg_market_snapshot_printing_source_time_idx
  ON "tcg_market_snapshot" ("printing_id", "source_key", "observed_at");
CREATE INDEX IF NOT EXISTS tcg_market_snapshot_printing_type_time_idx
  ON "tcg_market_snapshot" ("printing_id", "market_type", "observed_at");
CREATE INDEX IF NOT EXISTS tcg_market_snapshot_printing_condition_idx
  ON "tcg_market_snapshot" ("printing_id", "condition", "grading_company", "grade_label", "observed_at");

CREATE TABLE IF NOT EXISTS "tcg_market_quarantine" (
  "id" text PRIMARY KEY,
  "source_key" text NOT NULL REFERENCES "tcg_market_source"("source_key"),
  "source_record_id" text NOT NULL,
  "reason" text NOT NULL,
  "printing_reference" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "payload" jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_quarantine_reason_chk CHECK (
    "reason" IN (
      'not_found', 'ambiguous', 'conflict', 'invalid_printing', 'concept_only', 'validation_error'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_market_quarantine_fingerprint_uidx
  ON "tcg_market_quarantine" ("source_key", "source_record_id", "fingerprint");
CREATE INDEX IF NOT EXISTS tcg_market_quarantine_lookup_idx
  ON "tcg_market_quarantine" ("source_key", "source_record_id");

CREATE TABLE IF NOT EXISTS "tcg_market_revision" (
  "id" text PRIMARY KEY,
  "source_key" text NOT NULL,
  "source_record_id" text NOT NULL,
  "existing_snapshot_id" text NOT NULL,
  "existing_fingerprint" text NOT NULL,
  "attempted_fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.forbid_tcg_market_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TCG market snapshots are immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION app.require_system_tcg_market_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'TCG market facts can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tcg_market_snapshot_immutable ON "tcg_market_snapshot";
CREATE TRIGGER tcg_market_snapshot_immutable
  BEFORE UPDATE OR DELETE ON "tcg_market_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_market_mutate();

DROP TRIGGER IF EXISTS tcg_market_snapshot_system_write ON "tcg_market_snapshot";
CREATE TRIGGER tcg_market_snapshot_system_write
  BEFORE INSERT ON "tcg_market_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_market_write();

DROP TRIGGER IF EXISTS tcg_market_quarantine_immutable ON "tcg_market_quarantine";
CREATE TRIGGER tcg_market_quarantine_immutable
  BEFORE UPDATE OR DELETE ON "tcg_market_quarantine"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_market_mutate();

DROP TRIGGER IF EXISTS tcg_market_quarantine_system_write ON "tcg_market_quarantine";
CREATE TRIGGER tcg_market_quarantine_system_write
  BEFORE INSERT ON "tcg_market_quarantine"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_market_write();

DROP TRIGGER IF EXISTS tcg_market_revision_immutable ON "tcg_market_revision";
CREATE TRIGGER tcg_market_revision_immutable
  BEFORE UPDATE OR DELETE ON "tcg_market_revision"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_market_mutate();

DROP TRIGGER IF EXISTS tcg_market_revision_system_write ON "tcg_market_revision";
CREATE TRIGGER tcg_market_revision_system_write
  BEFORE INSERT ON "tcg_market_revision"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_market_write();

DROP TRIGGER IF EXISTS tcg_market_ingest_system_write ON "tcg_market_ingest";
CREATE TRIGGER tcg_market_ingest_system_write
  BEFORE INSERT ON "tcg_market_ingest"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_market_write();

DROP TRIGGER IF EXISTS tcg_market_source_immutable ON "tcg_market_source";
CREATE TRIGGER tcg_market_source_immutable
  BEFORE UPDATE OR DELETE ON "tcg_market_source"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();
