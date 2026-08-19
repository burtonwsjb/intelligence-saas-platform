-- Phase 03: active-tenant RLS, audit log, canonical tenant-owned table.
-- Database roles/grants are provisioned by db:bootstrap, not this file.

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_organization_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(btrim(current_setting('app.current_organization_id', true)), '')
$$;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(btrim(current_setting('app.current_user_id', true)), '')
$$;

CREATE OR REPLACE FUNCTION app.has_active_membership()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.member AS m
    WHERE m.organization_id = app.current_organization_id()
      AND m.user_id = app.current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION app.tenant_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant AS t
    WHERE t.organization_id = app.current_organization_id()
      AND t.status = 'active'
  )
$$;

CREATE TABLE IF NOT EXISTS "audit_event" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_event_organization_created_idx
  ON "audit_event" ("organization_id", "created_at");

CREATE TABLE IF NOT EXISTS "tenant_resource" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "body" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_resource_organization_id_idx
  ON "tenant_resource" ("organization_id");

ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_resource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_resource" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "tenant";
DROP POLICY IF EXISTS tenant_select ON "tenant";
DROP POLICY IF EXISTS tenant_insert ON "tenant";
DROP POLICY IF EXISTS tenant_update ON "tenant";
DROP POLICY IF EXISTS audit_event_select ON "audit_event";
DROP POLICY IF EXISTS audit_event_insert ON "audit_event";
DROP POLICY IF EXISTS tenant_resource_select ON "tenant_resource";
DROP POLICY IF EXISTS tenant_resource_insert ON "tenant_resource";
DROP POLICY IF EXISTS tenant_resource_update ON "tenant_resource";
DROP POLICY IF EXISTS tenant_resource_delete ON "tenant_resource";

CREATE POLICY tenant_select ON "tenant"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY tenant_insert ON "tenant"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND "created_by_user_id" = app.current_user_id()
    AND app.has_active_membership()
  );

CREATE POLICY tenant_update ON "tenant"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY audit_event_select ON "audit_event"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY audit_event_insert ON "audit_event"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY tenant_resource_select ON "tenant_resource"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  );

CREATE POLICY tenant_resource_insert ON "tenant_resource"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  );

CREATE POLICY tenant_resource_update ON "tenant_resource"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  );

CREATE POLICY tenant_resource_delete ON "tenant_resource"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  );
