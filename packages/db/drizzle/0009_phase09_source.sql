-- Phase 09: source-intelligence ingestion (YouTube/Reddit/web fixtures).
-- Platform-global public source accounts and content. No tenant RLS.
-- No HTML scraping. No real provider network calls.

CREATE TABLE IF NOT EXISTS "source_platform" (
  "source_type" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_platform_type_chk CHECK (
    "source_type" IN ('youtube', 'reddit', 'web', 'rss', 'manual')
  ),
  CONSTRAINT source_platform_status_chk CHECK ("status" IN ('active', 'disabled'))
);

INSERT INTO "source_platform" ("source_type", "display_name")
VALUES
  ('youtube', 'YouTube'),
  ('reddit', 'Reddit'),
  ('web', 'Web'),
  ('rss', 'RSS'),
  ('manual', 'Manual')
ON CONFLICT ("source_type") DO NOTHING;

CREATE TABLE IF NOT EXISTS "source_account" (
  "id" text PRIMARY KEY,
  "source_type" text NOT NULL REFERENCES "source_platform"("source_type"),
  "external_account_id" text NOT NULL,
  "handle" text,
  "display_name" text,
  "canonical_url" text,
  "status" text NOT NULL DEFAULT 'active',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_account_status_chk CHECK ("status" IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS source_account_external_uidx
  ON "source_account" ("source_type", "external_account_id");

CREATE TABLE IF NOT EXISTS "source_ingest" (
  "id" text PRIMARY KEY,
  "source_type" text NOT NULL REFERENCES "source_platform"("source_type"),
  "source_record_id" text NOT NULL,
  "event_type" text NOT NULL,
  "fingerprint" text NOT NULL,
  "payload" jsonb NOT NULL,
  "processing_status" text NOT NULL DEFAULT 'received',
  "content_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_ingest_status_chk CHECK (
    "processing_status" IN ('received', 'processed', 'failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS source_ingest_record_uidx
  ON "source_ingest" ("source_type", "source_record_id");

CREATE TABLE IF NOT EXISTS "source_content" (
  "id" text PRIMARY KEY,
  "source_type" text NOT NULL REFERENCES "source_platform"("source_type"),
  "external_content_id" text NOT NULL,
  "account_id" text NOT NULL REFERENCES "source_account"("id"),
  "published_at" timestamptz NOT NULL,
  "ingested_at" timestamptz NOT NULL DEFAULT now(),
  "title" text,
  "summary" text,
  "canonical_url" text NOT NULL,
  "content_type" text NOT NULL,
  "language" text,
  "license_status" text NOT NULL DEFAULT 'reference_only',
  "retention_policy" text NOT NULL DEFAULT 'bounded_excerpt',
  "transcript_available" boolean NOT NULL DEFAULT false,
  "excerpt" text,
  "excerpt_hash" text,
  "fingerprint" text NOT NULL,
  "data_quality" text NOT NULL DEFAULT 'complete',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_content_type_chk CHECK (
    "content_type" IN ('video', 'post', 'comment', 'article', 'manual_note')
  ),
  CONSTRAINT source_content_license_chk CHECK (
    "license_status" IN ('unknown', 'reference_only', 'bounded_excerpt', 'licensed')
  ),
  CONSTRAINT source_content_retention_chk CHECK (
    "retention_policy" IN ('reference_only', 'bounded_excerpt', 'derived_only')
  ),
  CONSTRAINT source_content_excerpt_chk CHECK (
    "excerpt" IS NULL OR char_length("excerpt") <= 500
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS source_content_external_uidx
  ON "source_content" ("source_type", "external_content_id");
CREATE INDEX IF NOT EXISTS source_content_account_time_idx
  ON "source_content" ("account_id", "published_at");
CREATE INDEX IF NOT EXISTS source_content_type_time_idx
  ON "source_content" ("source_type", "published_at");

CREATE TABLE IF NOT EXISTS "source_content_segment" (
  "id" text PRIMARY KEY,
  "content_id" text NOT NULL REFERENCES "source_content"("id"),
  "kind" text NOT NULL,
  "start_ref" text,
  "end_ref" text,
  "excerpt" text,
  "excerpt_hash" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_segment_kind_chk CHECK (
    "kind" IN ('timestamp_range', 'paragraph', 'comment')
  ),
  CONSTRAINT source_segment_excerpt_chk CHECK (
    "excerpt" IS NULL OR char_length("excerpt") <= 500
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS source_segment_uidx
  ON "source_content_segment" ("content_id", "kind", COALESCE("start_ref", ''), COALESCE("end_ref", ''));
CREATE INDEX IF NOT EXISTS source_segment_content_idx
  ON "source_content_segment" ("content_id");

CREATE TABLE IF NOT EXISTS "source_mention" (
  "id" text PRIMARY KEY,
  "content_id" text NOT NULL REFERENCES "source_content"("id"),
  "segment_id" text REFERENCES "source_content_segment"("id"),
  "raw_entity_text" text NOT NULL,
  "normalized_entity_text" text NOT NULL,
  "mention_context" text NOT NULL DEFAULT 'other',
  "candidate_direction" text,
  "candidate_timeframe" text,
  "candidate_price" numeric(20, 8),
  "candidate_percent" numeric(12, 6),
  "sentiment" text NOT NULL DEFAULT 'unknown',
  "sentiment_confidence" numeric(5, 4),
  "extraction_version" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_mention_context_chk CHECK (
    "mention_context" IN ('identity', 'price', 'recommendation', 'pull', 'other')
  ),
  CONSTRAINT source_mention_sentiment_chk CHECK (
    "sentiment" IN ('positive', 'negative', 'neutral', 'mixed', 'unknown')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS source_mention_uidx
  ON "source_mention" ("content_id", "normalized_entity_text", COALESCE("segment_id", ''), "mention_context");
CREATE INDEX IF NOT EXISTS source_mention_content_idx
  ON "source_mention" ("content_id");
CREATE INDEX IF NOT EXISTS source_mention_text_idx
  ON "source_mention" ("normalized_entity_text");

CREATE TABLE IF NOT EXISTS "source_engagement_snapshot" (
  "id" text PRIMARY KEY,
  "content_id" text NOT NULL REFERENCES "source_content"("id"),
  "observed_at" timestamptz NOT NULL,
  "views" integer,
  "likes" integer,
  "comments" integer,
  "upvotes" integer,
  "score" integer,
  "reply_count" integer,
  "published_age_seconds" integer,
  "source_record_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS source_engagement_record_uidx
  ON "source_engagement_snapshot" ("content_id", "source_record_id");
CREATE INDEX IF NOT EXISTS source_engagement_time_idx
  ON "source_engagement_snapshot" ("content_id", "observed_at");

CREATE OR REPLACE FUNCTION app.forbid_source_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Source intelligence facts are immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION app.require_system_source_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Source intelligence facts can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_content_immutable ON "source_content";
CREATE TRIGGER source_content_immutable
  BEFORE UPDATE OR DELETE ON "source_content"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_source_mutate();

DROP TRIGGER IF EXISTS source_content_system_write ON "source_content";
CREATE TRIGGER source_content_system_write
  BEFORE INSERT ON "source_content"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_segment_immutable ON "source_content_segment";
CREATE TRIGGER source_segment_immutable
  BEFORE UPDATE OR DELETE ON "source_content_segment"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_source_mutate();

DROP TRIGGER IF EXISTS source_segment_system_write ON "source_content_segment";
CREATE TRIGGER source_segment_system_write
  BEFORE INSERT ON "source_content_segment"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_mention_immutable ON "source_mention";
CREATE TRIGGER source_mention_immutable
  BEFORE UPDATE OR DELETE ON "source_mention"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_source_mutate();

DROP TRIGGER IF EXISTS source_mention_system_write ON "source_mention";
CREATE TRIGGER source_mention_system_write
  BEFORE INSERT ON "source_mention"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_engagement_immutable ON "source_engagement_snapshot";
CREATE TRIGGER source_engagement_immutable
  BEFORE UPDATE OR DELETE ON "source_engagement_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_source_mutate();

DROP TRIGGER IF EXISTS source_engagement_system_write ON "source_engagement_snapshot";
CREATE TRIGGER source_engagement_system_write
  BEFORE INSERT ON "source_engagement_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_ingest_system_write ON "source_ingest";
CREATE TRIGGER source_ingest_system_write
  BEFORE INSERT ON "source_ingest"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_account_system_write ON "source_account";
CREATE TRIGGER source_account_system_write
  BEFORE INSERT ON "source_account"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS source_platform_immutable ON "source_platform";
CREATE TRIGGER source_platform_immutable
  BEFORE UPDATE OR DELETE ON "source_platform"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();
