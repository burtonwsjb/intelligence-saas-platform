ALTER TABLE "tcg_market_snapshot" DROP CONSTRAINT IF EXISTS tcg_market_snapshot_quality_chk;
ALTER TABLE "tcg_market_snapshot" ADD CONSTRAINT tcg_market_snapshot_quality_chk CHECK (
  "quality_label" IN ('verified', 'normal', 'suspect', 'outlier', 'incomplete', 'stale')
);

ALTER TABLE "tcg_market_quarantine" DROP CONSTRAINT IF EXISTS tcg_market_quarantine_reason_chk;
ALTER TABLE "tcg_market_quarantine" ADD CONSTRAINT tcg_market_quarantine_reason_chk CHECK (
  "reason" IN (
    'not_found',
    'ambiguous',
    'conflict',
    'invalid_printing',
    'concept_only',
    'validation_error',
    'impossible_timestamp'
  )
);

-- Phase 24: real data source integration. Platform provider runtime, outbox,
-- sentiment, quarantine review, and worker heartbeat. No tenant writes.
-- Provider credentials stay in environment secrets only.

ALTER TABLE "platform_break_glass_audit" DROP CONSTRAINT IF EXISTS platform_break_glass_action_chk;
ALTER TABLE "platform_break_glass_audit" ADD CONSTRAINT platform_break_glass_action_chk CHECK (
  "action" IN (
    'tenant.inspect',
    'creator.exclude',
    'creator.trust',
    'index.upsert',
    'support.case',
    'predictions.preview',
    'health.view',
    'beta.invite',
    'feature.flag',
    'provider.enable',
    'provider.disable',
    'provider.pause',
    'provider.resume',
    'provider.sync',
    'provider.retry',
    'quarantine.retry',
    'quarantine.resolve',
    'quarantine.dismiss'
  )
);

CREATE TABLE IF NOT EXISTS "provider_runtime" (
  "provider_key" text PRIMARY KEY,
  "provider_type" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'disabled',
  "enabled" boolean NOT NULL DEFAULT false,
  "paused" boolean NOT NULL DEFAULT false,
  "credential_status" text NOT NULL DEFAULT 'missing',
  "health_status" text NOT NULL DEFAULT 'unknown',
  "last_success_at" timestamptz,
  "last_failure_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_error_class" text,
  "rate_limit_remaining" integer,
  "rate_limit_reset_at" timestamptz,
  "retry_after_at" timestamptz,
  "cursor" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_source_timestamp" timestamptz,
  "last_source_id" text,
  "schedule_seconds" integer NOT NULL DEFAULT 900,
  "lease_until" timestamptz,
  "records_ingested" integer NOT NULL DEFAULT 0,
  "records_quarantined" integer NOT NULL DEFAULT 0,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_runtime_type_chk CHECK ("provider_type" IN ('market', 'social', 'creator')),
  CONSTRAINT provider_runtime_mode_chk CHECK ("mode" IN ('disabled', 'fixture', 'live')),
  CONSTRAINT provider_runtime_schedule_chk CHECK ("schedule_seconds" >= 30 AND "schedule_seconds" <= 604800)
);

INSERT INTO "provider_runtime" ("provider_key", "provider_type", "mode", "schedule_seconds", "capabilities")
VALUES
  ('tcg_card_central', 'market', 'disabled', 300, '{"supported_games":["pokemon"],"supported_languages":["en","ja","zh-Hans"],"supported_regions":["US","JP"],"supported_market_types":["marketplace_sold","marketplace_listing","market_price"],"supported_content_types":[]}'::jsonb),
  ('tcgplayer', 'market', 'disabled', 300, '{"supported_games":["pokemon"],"supported_languages":["en"],"supported_regions":["US"],"supported_market_types":["marketplace_sold","marketplace_listing"],"supported_content_types":[]}'::jsonb),
  ('ebay', 'market', 'disabled', 600, '{"supported_games":["pokemon"],"supported_languages":["en"],"supported_regions":["US"],"supported_market_types":["marketplace_sold"],"supported_content_types":[]}'::jsonb),
  ('reddit', 'social', 'disabled', 900, '{"supported_games":["pokemon"],"supported_languages":["en"],"supported_regions":["US"],"supported_market_types":[],"supported_content_types":["post","comment"]}'::jsonb),
  ('youtube', 'social', 'disabled', 1800, '{"supported_games":["pokemon"],"supported_languages":["en","ja"],"supported_regions":["US","JP"],"supported_market_types":[],"supported_content_types":["video"]}'::jsonb)
ON CONFLICT ("provider_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "provider_sync_run" (
  "id" text PRIMARY KEY,
  "provider_key" text NOT NULL REFERENCES "provider_runtime"("provider_key"),
  "mode" text NOT NULL,
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'started',
  "limit_count" integer,
  "received_count" integer NOT NULL DEFAULT 0,
  "quarantined_count" integer NOT NULL DEFAULT 0,
  "error_class" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "checkpoint" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT provider_sync_run_status_chk CHECK ("status" IN ('started', 'completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS provider_sync_run_provider_time_idx
  ON "provider_sync_run" ("provider_key", "started_at");

CREATE TABLE IF NOT EXISTS "platform_outbox" (
  "id" text PRIMARY KEY,
  "job_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  CONSTRAINT platform_outbox_status_chk CHECK (
    "status" IN ('pending', 'published', 'processing', 'processed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS platform_outbox_pending_idx ON "platform_outbox" ("status", "available_at");
CREATE INDEX IF NOT EXISTS platform_outbox_type_idx ON "platform_outbox" ("job_type", "status");

CREATE TABLE IF NOT EXISTS "source_sentiment" (
  "id" text PRIMARY KEY,
  "mention_id" text NOT NULL REFERENCES "source_mention"("id"),
  "analyzer_version" text NOT NULL,
  "direction" text NOT NULL,
  "strength" text NOT NULL,
  "confidence" text,
  "subject" text NOT NULL,
  "entity_kind" text NOT NULL,
  "time_horizon" text NOT NULL,
  "market_relevance" text NOT NULL,
  "excitement" text NOT NULL,
  "purchase_intent" text NOT NULL,
  "price_expectation" text NOT NULL,
  "creator_recommendation" text NOT NULL,
  "market_concern" text NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS source_sentiment_mention_version_uidx
  ON "source_sentiment" ("mention_id", "analyzer_version");

CREATE TABLE IF NOT EXISTS "intelligence_quarantine" (
  "id" text PRIMARY KEY,
  "provider_key" text NOT NULL,
  "record_type" text NOT NULL,
  "reason" text NOT NULL,
  "payload_summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "fingerprint" text NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "resolution_state" text NOT NULL DEFAULT 'open',
  "resolution_reason" text,
  "resolved_at" timestamptz,
  "resolved_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_quarantine_state_chk CHECK (
    "resolution_state" IN ('open', 'retried', 'resolved', 'dismissed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS intelligence_quarantine_fingerprint_uidx
  ON "intelligence_quarantine" ("provider_key", "record_type", "fingerprint");
CREATE INDEX IF NOT EXISTS intelligence_quarantine_open_idx
  ON "intelligence_quarantine" ("resolution_state", "received_at");

CREATE TABLE IF NOT EXISTS "tcg_market_quarantine_review" (
  "id" text PRIMARY KEY,
  "quarantine_id" text NOT NULL REFERENCES "tcg_market_quarantine"("id"),
  "action" text NOT NULL,
  "reason" text NOT NULL,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_quarantine_review_action_chk CHECK (
    "action" IN ('retry', 'resolve_identity', 'dismiss')
  )
);

CREATE INDEX IF NOT EXISTS tcg_market_quarantine_review_qid_idx
  ON "tcg_market_quarantine_review" ("quarantine_id", "created_at");

CREATE TABLE IF NOT EXISTS "worker_heartbeat" (
  "worker_key" text PRIMARY KEY,
  "last_seen_at" timestamptz NOT NULL,
  "queue_depth" integer,
  "failed_jobs" integer,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.require_system_provider_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Provider runtime can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_runtime_system_write ON "provider_runtime";
CREATE TRIGGER provider_runtime_system_write
  BEFORE INSERT OR UPDATE ON "provider_runtime"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_provider_write();

DROP TRIGGER IF EXISTS provider_sync_run_system_write ON "provider_sync_run";
CREATE TRIGGER provider_sync_run_system_write
  BEFORE INSERT OR UPDATE ON "provider_sync_run"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_provider_write();

DROP TRIGGER IF EXISTS platform_outbox_system_write ON "platform_outbox";
CREATE TRIGGER platform_outbox_system_write
  BEFORE INSERT OR UPDATE ON "platform_outbox"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_provider_write();

DROP TRIGGER IF EXISTS source_sentiment_system_write ON "source_sentiment";
CREATE TRIGGER source_sentiment_system_write
  BEFORE INSERT ON "source_sentiment"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_source_write();

DROP TRIGGER IF EXISTS intelligence_quarantine_system_write ON "intelligence_quarantine";
CREATE TRIGGER intelligence_quarantine_system_write
  BEFORE INSERT OR UPDATE ON "intelligence_quarantine"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_provider_write();

DROP TRIGGER IF EXISTS tcg_market_quarantine_review_system_write ON "tcg_market_quarantine_review";
CREATE TRIGGER tcg_market_quarantine_review_system_write
  BEFORE INSERT ON "tcg_market_quarantine_review"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_market_write();

DROP TRIGGER IF EXISTS worker_heartbeat_system_write ON "worker_heartbeat";
CREATE TRIGGER worker_heartbeat_system_write
  BEFORE INSERT OR UPDATE ON "worker_heartbeat"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_provider_write();

CREATE OR REPLACE FUNCTION app.list_pending_platform_outbox(p_limit integer)
RETURNS TABLE (id text, job_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.job_type
  FROM "platform_outbox" o
  WHERE o.status = 'pending'
    AND o.available_at <= now()
  ORDER BY o.available_at
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

REVOKE ALL ON FUNCTION app.list_pending_platform_outbox(integer) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION app.list_pending_platform_outbox(integer)
    TO app_worker, app_migrate, app_admin;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
