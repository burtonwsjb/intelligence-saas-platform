-- Phase 40: automatic social discovery topics and discovered-creator relevance.
-- Forward-only. No secret columns. Platform tables only.

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
    'quarantine.dismiss',
    'discovery.topic',
    'discovery.run',
    'discovery.monitor',
    'discovery.exclude'
  )
);

CREATE TABLE IF NOT EXISTS "discovery_topic" (
  "id" text PRIMARY KEY,
  "provider_key" text NOT NULL,
  "query" text NOT NULL,
  "strategy_key" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 100,
  "last_run_at" timestamptz,
  "last_error_class" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_topic_provider_chk CHECK ("provider_key" IN ('youtube', 'reddit')),
  CONSTRAINT discovery_topic_query_chk CHECK (char_length("query") BETWEEN 3 AND 120),
  CONSTRAINT discovery_topic_priority_chk CHECK ("priority" BETWEEN 1 AND 1000),
  CONSTRAINT discovery_topic_provider_query_uidx UNIQUE ("provider_key", "query")
);

CREATE TABLE IF NOT EXISTS "discovery_run" (
  "id" text PRIMARY KEY,
  "topic_id" text REFERENCES "discovery_topic"("id"),
  "provider_key" text NOT NULL,
  "query" text NOT NULL,
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'started',
  "videos_seen" integer NOT NULL DEFAULT 0,
  "channels_seen" integer NOT NULL DEFAULT 0,
  "creators_linked" integer NOT NULL DEFAULT 0,
  "content_ingested" integer NOT NULL DEFAULT 0,
  "quota_units" integer NOT NULL DEFAULT 0,
  "error_class" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT discovery_run_provider_chk CHECK ("provider_key" IN ('youtube', 'reddit')),
  CONSTRAINT discovery_run_trigger_chk CHECK ("trigger" IN ('schedule', 'admin', 'staging')),
  CONSTRAINT discovery_run_status_chk CHECK ("status" IN ('started', 'completed', 'failed', 'skipped'))
);

CREATE TABLE IF NOT EXISTS "discovered_creator" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL REFERENCES "creator"("id"),
  "source_account_id" text NOT NULL REFERENCES "source_account"("id"),
  "provider_key" text NOT NULL,
  "external_account_id" text NOT NULL,
  "display_name" text,
  "first_topic_id" text REFERENCES "discovery_topic"("id"),
  "last_topic_id" text REFERENCES "discovery_topic"("id"),
  "topic_hits" integer NOT NULL DEFAULT 1,
  "relevance_score" numeric(8, 4) NOT NULL DEFAULT 0,
  "relevance_state" text NOT NULL DEFAULT 'candidate',
  "reach_views" integer,
  "reach_subscribers" integer,
  "discovery_provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_discovered_at" timestamptz NOT NULL DEFAULT now(),
  "last_discovered_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovered_creator_provider_chk CHECK ("provider_key" IN ('youtube', 'reddit')),
  CONSTRAINT discovered_creator_state_chk CHECK (
    "relevance_state" IN ('candidate', 'monitored', 'excluded', 'low_confidence')
  ),
  CONSTRAINT discovered_creator_external_uidx UNIQUE ("provider_key", "external_account_id")
);

CREATE INDEX IF NOT EXISTS discovered_creator_state_idx ON "discovered_creator" ("relevance_state", "relevance_score");
CREATE INDEX IF NOT EXISTS discovery_topic_enabled_idx ON "discovery_topic" ("enabled", "last_run_at");

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "discovery_topic", "discovery_run", "discovered_creator"
  TO app_migrate, app_admin;

  GRANT SELECT ON TABLE
    "discovery_topic", "discovery_run", "discovered_creator"
  TO app_user, app_worker;

  GRANT SELECT, INSERT, UPDATE ON TABLE
    "discovery_topic", "discovery_run", "discovered_creator"
  TO app_worker;

  REVOKE INSERT, UPDATE, DELETE ON TABLE
    "discovery_topic", "discovery_run", "discovered_creator"
  FROM app_user;

  REVOKE DELETE ON TABLE
    "discovery_topic", "discovery_run", "discovered_creator"
  FROM app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
