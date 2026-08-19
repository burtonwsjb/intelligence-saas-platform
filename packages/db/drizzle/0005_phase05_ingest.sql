-- Phase 05: durable ingest boundary + outbox. No observations/signals.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "source_event" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "idempotency_key" text NOT NULL,
  "request_id" text,
  "fingerprint" text NOT NULL,
  "entity" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metrics" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processing_status" text NOT NULL DEFAULT 'received',
  "failure_category" text,
  "failure_message" text,
  "created_by_api_key_id" text REFERENCES "api_key"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_event_status_chk CHECK (
    "processing_status" IN ('received', 'queued', 'processing', 'processed', 'failed')
  ),
  CONSTRAINT source_event_failure_chk CHECK (
    "failure_category" IS NULL OR "failure_category" IN ('transient', 'permanent')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS source_event_org_idempotency_uidx
  ON "source_event" ("organization_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS source_event_organization_id_idx
  ON "source_event" ("organization_id");

CREATE TABLE IF NOT EXISTS "outbox_job" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "source_event_id" text NOT NULL REFERENCES "source_event"("id") ON DELETE CASCADE,
  "job_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT outbox_job_status_chk CHECK (
    "status" IN ('pending', 'published', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS outbox_job_pending_idx
  ON "outbox_job" ("status", "available_at");

CREATE INDEX IF NOT EXISTS outbox_job_organization_id_idx
  ON "outbox_job" ("organization_id");

CREATE OR REPLACE FUNCTION app.list_pending_outbox(p_limit integer)
RETURNS TABLE (
  id text,
  organization_id text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    p_limit := 20;
  END IF;
  RETURN QUERY
    SELECT j.id, j.organization_id
    FROM public.outbox_job AS j
    WHERE j.status = 'pending'
      AND j.available_at <= now()
    ORDER BY j.created_at
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app.list_pending_outbox(integer) FROM PUBLIC;

ALTER TABLE "source_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outbox_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_job" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS source_event_select ON "source_event";
DROP POLICY IF EXISTS source_event_insert ON "source_event";
DROP POLICY IF EXISTS source_event_update ON "source_event";
DROP POLICY IF EXISTS outbox_job_select ON "outbox_job";
DROP POLICY IF EXISTS outbox_job_insert ON "outbox_job";
DROP POLICY IF EXISTS outbox_job_update ON "outbox_job";

CREATE POLICY source_event_select ON "source_event"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY source_event_insert ON "source_event"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
    AND app.tenant_is_active()
  );

CREATE POLICY source_event_update ON "source_event"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY outbox_job_select ON "outbox_job"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY outbox_job_insert ON "outbox_job"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
    AND app.tenant_is_active()
  );

CREATE POLICY outbox_job_update ON "outbox_job"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
