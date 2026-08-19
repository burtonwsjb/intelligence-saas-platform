-- Phase 04: billing, entitlements, API keys, usage, machine principal RLS.
-- Stripe price IDs are not stored here. Roles/grants stay in db:bootstrap.

CREATE OR REPLACE FUNCTION app.current_principal_type()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(btrim(current_setting('app.current_principal_type', true)), '')
$$;

CREATE OR REPLACE FUNCTION app.current_api_key_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(btrim(current_setting('app.current_api_key_id', true)), '')
$$;

CREATE TABLE IF NOT EXISTS "plan" (
  "key" text PRIMARY KEY,
  "name" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS "plan_entitlement" (
  "plan_key" text NOT NULL REFERENCES "plan"("key") ON DELETE CASCADE,
  "entitlement_key" text NOT NULL,
  "value_kind" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "limit_value" integer,
  PRIMARY KEY ("plan_key", "entitlement_key")
);

INSERT INTO "plan" ("key", "name") VALUES
  ('free', 'Free'),
  ('starter', 'Starter'),
  ('growth', 'Growth'),
  ('scale', 'Scale')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "plan_entitlement" ("plan_key", "entitlement_key", "value_kind", "enabled", "limit_value")
VALUES
  ('free', 'api_requests_per_month', 'limit', true, 1000),
  ('free', 'api_keys', 'limit', true, 1),
  ('free', 'team_members', 'limit', true, 3),
  ('free', 'projects', 'limit', true, 1),
  ('free', 'history_depth_days', 'limit', true, 30),
  ('free', 'predictions', 'boolean', false, NULL),
  ('free', 'creator_analytics', 'boolean', false, NULL),
  ('free', 'content_generation', 'boolean', false, NULL),
  ('free', 'alerts', 'boolean', false, NULL),
  ('free', 'webhooks', 'boolean', false, NULL),
  ('free', 'exports', 'boolean', false, NULL),
  ('free', 'premium_data', 'boolean', false, NULL),
  ('starter', 'api_requests_per_month', 'limit', true, 25000),
  ('starter', 'api_keys', 'limit', true, 5),
  ('starter', 'team_members', 'limit', true, 8),
  ('starter', 'projects', 'limit', true, 5),
  ('starter', 'history_depth_days', 'limit', true, 90),
  ('starter', 'predictions', 'boolean', true, NULL),
  ('starter', 'creator_analytics', 'boolean', false, NULL),
  ('starter', 'content_generation', 'boolean', false, NULL),
  ('starter', 'alerts', 'boolean', true, NULL),
  ('starter', 'webhooks', 'boolean', false, NULL),
  ('starter', 'exports', 'boolean', true, NULL),
  ('starter', 'premium_data', 'boolean', false, NULL),
  ('growth', 'api_requests_per_month', 'limit', true, 150000),
  ('growth', 'api_keys', 'limit', true, 20),
  ('growth', 'team_members', 'limit', true, 25),
  ('growth', 'projects', 'limit', true, 25),
  ('growth', 'history_depth_days', 'limit', true, 365),
  ('growth', 'predictions', 'boolean', true, NULL),
  ('growth', 'creator_analytics', 'boolean', true, NULL),
  ('growth', 'content_generation', 'boolean', true, NULL),
  ('growth', 'alerts', 'boolean', true, NULL),
  ('growth', 'webhooks', 'boolean', true, NULL),
  ('growth', 'exports', 'boolean', true, NULL),
  ('growth', 'premium_data', 'boolean', false, NULL),
  ('scale', 'api_requests_per_month', 'limit', true, 1000000),
  ('scale', 'api_keys', 'limit', true, 100),
  ('scale', 'team_members', 'limit', true, 100),
  ('scale', 'projects', 'limit', true, 100),
  ('scale', 'history_depth_days', 'limit', true, 1825),
  ('scale', 'predictions', 'boolean', true, NULL),
  ('scale', 'creator_analytics', 'boolean', true, NULL),
  ('scale', 'content_generation', 'boolean', true, NULL),
  ('scale', 'alerts', 'boolean', true, NULL),
  ('scale', 'webhooks', 'boolean', true, NULL),
  ('scale', 'exports', 'boolean', true, NULL),
  ('scale', 'premium_data', 'boolean', true, NULL)
ON CONFLICT ("plan_key", "entitlement_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "tenant_billing" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "plan_key" text NOT NULL DEFAULT 'free' REFERENCES "plan"("key"),
  "status" text NOT NULL DEFAULT 'none',
  "current_period_end" timestamptz,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_billing_stripe_customer_uidx
  ON "tenant_billing" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "tenant_entitlement_override" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entitlement_key" text NOT NULL,
  "value_kind" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "limit_value" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "entitlement_key")
);

CREATE TABLE IF NOT EXISTS "stripe_event" (
  "id" text PRIMARY KEY,
  "type" text NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE SET NULL,
  "stripe_customer_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "api_key" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "prefix" text NOT NULL UNIQUE,
  "secret_hash" text NOT NULL,
  "scopes" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "environment" text NOT NULL DEFAULT 'test',
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "expires_at" timestamptz,
  "revoked_at" timestamptz
);

CREATE INDEX IF NOT EXISTS api_key_organization_id_idx
  ON "api_key" ("organization_id");

CREATE TABLE IF NOT EXISTS "usage_event" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "api_key_id" text REFERENCES "api_key"("id") ON DELETE SET NULL,
  "meter_key" text NOT NULL,
  "quantity" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "idempotency_key" text
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_event_org_idempotency_uidx
  ON "usage_event" ("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_event_organization_id_idx
  ON "usage_event" ("organization_id");

CREATE TABLE IF NOT EXISTS "usage_month" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "meter_key" text NOT NULL,
  "period_start" timestamptz NOT NULL,
  "quantity" bigint NOT NULL DEFAULT 0,
  PRIMARY KEY ("organization_id", "meter_key", "period_start")
);

-- SECURITY DEFINER: invoker RLS on api_key would recurse into this function.
-- Reads only the current key id + organization from session settings.
CREATE OR REPLACE FUNCTION app.has_machine_principal()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    COALESCE(nullif(btrim(current_setting('app.current_principal_type', true)), ''), '') = 'machine'
    AND nullif(btrim(current_setting('app.current_api_key_id', true)), '') IS NOT NULL
    AND nullif(btrim(current_setting('app.current_organization_id', true)), '') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.api_key AS k
      WHERE k.id = nullif(btrim(current_setting('app.current_api_key_id', true)), '')
        AND k.organization_id = nullif(btrim(current_setting('app.current_organization_id', true)), '')
        AND k.status = 'active'
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
    )
$$;

CREATE OR REPLACE FUNCTION app.has_system_principal()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT
    COALESCE(app.current_principal_type(), '') = 'system'
    AND app.current_organization_id() IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION app.is_authorized_principal()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN COALESCE(app.current_principal_type(), 'user') = 'machine' THEN app.has_machine_principal()
    WHEN COALESCE(app.current_principal_type(), 'user') = 'system' THEN app.has_system_principal()
    ELSE app.has_active_membership()
  END
$$;

-- Prefix lookup happens before tenant context exists. SECURITY DEFINER is
-- required, scoped to one prefix, pinned search_path, no arbitrary SQL.
CREATE OR REPLACE FUNCTION app.lookup_api_key_by_prefix(p_prefix text)
RETURNS TABLE (
  id text,
  organization_id text,
  secret_hash text,
  scopes text,
  status text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^[A-Za-z0-9_]{8,64}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT k.id, k.organization_id, k.secret_hash, k.scopes, k.status, k.expires_at, k.revoked_at
    FROM public.api_key AS k
    WHERE k.prefix = p_prefix
    LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_stripe_event(
  p_id text,
  p_type text,
  p_organization_id text,
  p_stripe_customer_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted integer;
BEGIN
  IF p_id IS NULL OR length(p_id) < 5 OR length(p_id) > 255 THEN
    RETURN false;
  END IF;
  INSERT INTO public.stripe_event (id, type, organization_id, stripe_customer_id)
  VALUES (p_id, p_type, p_organization_id, p_stripe_customer_id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END;
$$;

CREATE OR REPLACE FUNCTION app.lookup_organization_by_stripe_customer(p_customer_id text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  found_id text;
BEGIN
  IF p_customer_id IS NULL OR p_customer_id !~ '^cus_[A-Za-z0-9]+$' THEN
    RETURN NULL;
  END IF;
  SELECT b.organization_id INTO found_id
  FROM public.tenant_billing AS b
  WHERE b.stripe_customer_id = p_customer_id
  LIMIT 1;
  RETURN found_id;
END;
$$;

REVOKE ALL ON FUNCTION app.has_machine_principal() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lookup_api_key_by_prefix(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_stripe_event(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lookup_organization_by_stripe_customer(text) FROM PUBLIC;

ALTER TABLE "tenant_billing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_billing" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_entitlement_override" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_entitlement_override" FORCE ROW LEVEL SECURITY;
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_key" FORCE ROW LEVEL SECURITY;
ALTER TABLE "usage_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "usage_month" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_month" FORCE ROW LEVEL SECURITY;

-- PGlite/unit tests apply SQL without bootstrapRoles. Real Postgres
-- bootstrap will ALTER this role to LOGIN with a password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

DROP POLICY IF EXISTS tenant_billing_definer_select ON "tenant_billing";
DROP POLICY IF EXISTS tenant_billing_select ON "tenant_billing";
DROP POLICY IF EXISTS tenant_billing_insert ON "tenant_billing";
DROP POLICY IF EXISTS tenant_billing_update ON "tenant_billing";
DROP POLICY IF EXISTS tenant_entitlement_override_select ON "tenant_entitlement_override";
DROP POLICY IF EXISTS tenant_entitlement_override_write ON "tenant_entitlement_override";
DROP POLICY IF EXISTS tenant_entitlement_override_update ON "tenant_entitlement_override";
DROP POLICY IF EXISTS api_key_definer_select ON "api_key";
DROP POLICY IF EXISTS api_key_select ON "api_key";
DROP POLICY IF EXISTS api_key_insert ON "api_key";
DROP POLICY IF EXISTS api_key_update ON "api_key";
DROP POLICY IF EXISTS usage_event_select ON "usage_event";
DROP POLICY IF EXISTS usage_event_insert ON "usage_event";
DROP POLICY IF EXISTS usage_month_select ON "usage_month";
DROP POLICY IF EXISTS usage_month_write ON "usage_month";
DROP POLICY IF EXISTS usage_month_update ON "usage_month";

-- SECURITY DEFINER lookups run as app_migrate with no tenant context.
-- FORCE RLS would otherwise hide every row from prefix/customer mapping.
CREATE POLICY tenant_billing_definer_select ON "tenant_billing"
  FOR SELECT
  TO app_migrate
  USING (true);

CREATE POLICY api_key_definer_select ON "api_key"
  FOR SELECT
  TO app_migrate
  USING (true);

CREATE POLICY tenant_billing_select ON "tenant_billing"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY tenant_billing_insert ON "tenant_billing"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY tenant_billing_update ON "tenant_billing"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY tenant_entitlement_override_select ON "tenant_entitlement_override"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY tenant_entitlement_override_write ON "tenant_entitlement_override"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY tenant_entitlement_override_update ON "tenant_entitlement_override"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
  );

CREATE POLICY api_key_select ON "api_key"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND (
      app.has_active_membership()
      OR (app.has_machine_principal() AND "id" = app.current_api_key_id())
    )
  );

CREATE POLICY api_key_insert ON "api_key"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.has_active_membership()
    AND app.tenant_is_active()
  );

CREATE POLICY api_key_update ON "api_key"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND (
      app.has_active_membership()
      OR (app.has_machine_principal() AND "id" = app.current_api_key_id())
    )
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND (
      app.has_active_membership()
      OR (app.has_machine_principal() AND "id" = app.current_api_key_id())
    )
  );

CREATE POLICY usage_event_select ON "usage_event"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY usage_event_insert ON "usage_event"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
    AND app.tenant_is_active()
  );

CREATE POLICY usage_month_select ON "usage_month"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY usage_month_write ON "usage_month"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE POLICY usage_month_update ON "usage_month"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

-- Machine/system principals may read tenant status to fail closed.
DROP POLICY IF EXISTS tenant_select ON "tenant";
CREATE POLICY tenant_select ON "tenant"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

DROP POLICY IF EXISTS audit_event_select ON "audit_event";
DROP POLICY IF EXISTS audit_event_insert ON "audit_event";
CREATE POLICY audit_event_select ON "audit_event"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
CREATE POLICY audit_event_insert ON "audit_event"
  FOR INSERT
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
