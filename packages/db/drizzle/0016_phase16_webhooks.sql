-- Phase 16: tenant webhook subscriptions and delivery logs. No production delivery.

CREATE TABLE IF NOT EXISTS "webhook_endpoint" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "secret_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "event_types" jsonb NOT NULL,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoint_status_chk CHECK ("status" IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS webhook_endpoint_org_idx
  ON "webhook_endpoint" ("organization_id", "status");

CREATE TABLE IF NOT EXISTS "webhook_delivery" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "endpoint_id" text NOT NULL REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "http_status" integer,
  "error_class" text,
  "response_excerpt" text,
  "next_retry_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_delivery_status_chk CHECK ("status" IN ('pending', 'delivered', 'failed', 'dead')),
  CONSTRAINT webhook_delivery_excerpt_chk CHECK ("response_excerpt" IS NULL OR char_length("response_excerpt") <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_event_uidx
  ON "webhook_delivery" ("endpoint_id", "event_id");
CREATE INDEX IF NOT EXISTS webhook_delivery_retry_idx
  ON "webhook_delivery" ("status", "next_retry_at");

ALTER TABLE "webhook_endpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoint" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_delivery" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_endpoint_select ON "webhook_endpoint";
DROP POLICY IF EXISTS webhook_endpoint_insert ON "webhook_endpoint";
DROP POLICY IF EXISTS webhook_endpoint_update ON "webhook_endpoint";
DROP POLICY IF EXISTS webhook_delivery_select ON "webhook_delivery";
DROP POLICY IF EXISTS webhook_delivery_insert ON "webhook_delivery";
DROP POLICY IF EXISTS webhook_delivery_update ON "webhook_delivery";

CREATE POLICY webhook_endpoint_select ON "webhook_endpoint"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY webhook_endpoint_insert ON "webhook_endpoint"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
    AND app.tenant_is_active()
  );

CREATE POLICY webhook_endpoint_update ON "webhook_endpoint"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY webhook_delivery_select ON "webhook_delivery"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY webhook_delivery_insert ON "webhook_delivery"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
    AND app.tenant_is_active()
  );

CREATE POLICY webhook_delivery_update ON "webhook_delivery"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
