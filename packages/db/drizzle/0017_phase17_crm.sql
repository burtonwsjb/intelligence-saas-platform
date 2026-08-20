-- Phase 17: CRM lifecycle, notifications, email delivery, alert rules, billing trial fields.
-- Operator notes/tags/segments are not tenant-readable. No production email provider required.

ALTER TABLE "tenant_billing"
  ADD COLUMN IF NOT EXISTS "trial_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "trial_ends_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "canceled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "past_due_since" timestamptz,
  ADD COLUMN IF NOT EXISTS "grace_ends_at" timestamptz;

CREATE TABLE IF NOT EXISTS "crm_organization_profile" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "display_name" text NOT NULL,
  "website" text,
  "industry" text,
  "primary_use_case" text,
  "customer_status" text NOT NULL DEFAULT 'signup',
  "lifecycle_stage" text NOT NULL DEFAULT 'signup',
  "lead_source" text,
  "signup_source" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "activated_at" timestamptz,
  "trial_started_at" timestamptz,
  "converted_at" timestamptz,
  "canceled_at" timestamptz,
  "last_activity_at" timestamptz,
  "activation_rule_version" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT crm_organization_profile_stage_chk CHECK (
    "lifecycle_stage" IN (
      'lead', 'signup', 'onboarding', 'activated', 'trial',
      'customer', 'at_risk', 'past_due', 'canceled', 'churned'
    )
  ),
  CONSTRAINT crm_organization_profile_status_chk CHECK (
    "customer_status" IN (
      'lead', 'signup', 'trial', 'active', 'at_risk', 'past_due', 'canceled', 'churned'
    )
  ),
  CONSTRAINT crm_organization_profile_website_chk CHECK (
    "website" IS NULL OR char_length("website") <= 200
  )
);

CREATE TABLE IF NOT EXISTS "crm_user_profile" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "display_name" text,
  "job_title" text,
  "timezone" text,
  "product_role" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "user_id"),
  CONSTRAINT crm_user_profile_display_chk CHECK (
    "display_name" IS NULL OR char_length("display_name") <= 80
  )
);

CREATE TABLE IF NOT EXISTS "crm_lifecycle_transition" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "from_stage" text NOT NULL,
  "to_stage" text NOT NULL,
  "reason" text NOT NULL,
  "actor_type" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_lifecycle_actor_chk CHECK ("actor_type" IN ('system', 'user', 'billing', 'operator'))
);

CREATE INDEX IF NOT EXISTS crm_lifecycle_transition_org_idx
  ON "crm_lifecycle_transition" ("organization_id", "created_at");

CREATE TABLE IF NOT EXISTS "crm_customer_event" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "idempotency_key" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_customer_event_type_chk CHECK (
    "event_type" IN (
      'user.signed_up',
      'organization.created',
      'onboarding.completed',
      'api_key.created',
      'first_event.ingested',
      'first_opportunity.viewed',
      'webhook.created',
      'subscription.started',
      'subscription.changed',
      'payment_failed',
      'subscription.canceled',
      'customer.reactivated'
    )
  )
);

CREATE INDEX IF NOT EXISTS crm_customer_event_org_idx
  ON "crm_customer_event" ("organization_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS crm_customer_event_idempotency_uidx
  ON "crm_customer_event" ("organization_id", "event_type", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "crm_operator_note" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "author_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "category" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_operator_note_category_chk CHECK (
    "category" IN ('account', 'billing', 'support', 'sales', 'risk', 'other')
  ),
  CONSTRAINT crm_operator_note_body_chk CHECK (char_length("body") BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS crm_operator_note_org_idx
  ON "crm_operator_note" ("organization_id", "created_at");

CREATE TABLE IF NOT EXISTS "crm_tag" (
  "key" text PRIMARY KEY,
  "label" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_tag_key_chk CHECK ("key" ~ '^[a-z0-9_]{1,40}$')
);

INSERT INTO "crm_tag" ("key", "label") VALUES
  ('trial', 'Trial'),
  ('high_usage', 'High usage'),
  ('developer', 'Developer'),
  ('vendor', 'Vendor'),
  ('collector', 'Collector'),
  ('enterprise_candidate', 'Enterprise candidate'),
  ('at_risk', 'At risk'),
  ('churned', 'Churned'),
  ('high_value', 'High value')
ON CONFLICT ("key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "crm_organization_tag" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "tag_key" text NOT NULL REFERENCES "crm_tag"("key") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "tag_key")
);

CREATE TABLE IF NOT EXISTS "crm_segment_definition" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL,
  "version" text NOT NULL,
  "rules" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_segment_definition_key_version_uidx
  ON "crm_segment_definition" ("key", "version");

CREATE TABLE IF NOT EXISTS "crm_segment_membership" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "segment_id" text NOT NULL REFERENCES "crm_segment_definition"("id") ON DELETE CASCADE,
  "evaluated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "segment_id")
);

CREATE TABLE IF NOT EXISTS "crm_churn_reason" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "note" text,
  "captured_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_churn_reason_category_chk CHECK (
    "category" IN ('too_expensive', 'missing_features', 'switched_product', 'low_usage', 'support', 'other')
  ),
  CONSTRAINT crm_churn_reason_note_chk CHECK ("note" IS NULL OR char_length("note") <= 500)
);

CREATE INDEX IF NOT EXISTS crm_churn_reason_org_idx
  ON "crm_churn_reason" ("organization_id", "captured_at");

CREATE TABLE IF NOT EXISTS "notification_preference" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "channel" text NOT NULL,
  "opted_in" boolean NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "user_id", "category", "channel"),
  CONSTRAINT notification_preference_category_chk CHECK (
    "category" IN (
      'account', 'billing', 'security', 'product', 'market_alert',
      'creator_alert', 'prediction', 'opportunity', 'usage', 'marketing'
    )
  ),
  CONSTRAINT notification_preference_channel_chk CHECK (
    "channel" IN ('in_app', 'email', 'webhook')
  )
);

CREATE TABLE IF NOT EXISTS "email_delivery" (
  "id" text PRIMARY KEY,
  "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "template_key" text NOT NULL,
  "template_version" text NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "failure_category" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT email_delivery_status_chk CHECK (
    "status" IN ('queued', 'sent', 'failed', 'suppressed')
  )
);

CREATE INDEX IF NOT EXISTS email_delivery_org_idx
  ON "email_delivery" ("organization_id", "created_at");

CREATE TABLE IF NOT EXISTS "in_app_notification" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'info',
  "reference_type" text,
  "reference_id" text,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT in_app_notification_severity_chk CHECK ("severity" IN ('info', 'warning', 'critical')),
  CONSTRAINT in_app_notification_body_chk CHECK (char_length("body") BETWEEN 1 AND 500),
  CONSTRAINT in_app_notification_title_chk CHECK (char_length("title") BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS in_app_notification_org_idx
  ON "in_app_notification" ("organization_id", "user_id", "created_at");

CREATE TABLE IF NOT EXISTS "alert_rule" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "rule_type" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "channel_preference" text NOT NULL DEFAULT 'in_app',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_rule_type_chk CHECK (
    "rule_type" IN (
      'opportunity_score_threshold',
      'recommendation_change',
      'price_move',
      'creator_call',
      'creator_consensus',
      'prediction_created',
      'usage_threshold',
      'webhook_failure'
    )
  ),
  CONSTRAINT alert_rule_channel_chk CHECK (
    "channel_preference" IN ('in_app', 'email', 'webhook')
  )
);

CREATE INDEX IF NOT EXISTS alert_rule_org_idx
  ON "alert_rule" ("organization_id", "enabled");

CREATE TABLE IF NOT EXISTS "usage_warning" (
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "meter_key" text NOT NULL,
  "period_start" timestamptz NOT NULL,
  "threshold_pct" integer NOT NULL,
  "notification_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "meter_key", "period_start", "threshold_pct"),
  CONSTRAINT usage_warning_threshold_chk CHECK ("threshold_pct" IN (50, 80, 90, 100))
);

CREATE OR REPLACE FUNCTION app.install_tenant_owned_rls(p_table text, p_allow_update boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_select', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_insert', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_update', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (organization_id = app.current_organization_id() AND app.is_authorized_principal())',
    p_table || '_select',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (organization_id = app.current_organization_id() AND app.is_authorized_principal() AND app.tenant_is_active())',
    p_table || '_insert',
    p_table
  );
  IF p_allow_update THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (organization_id = app.current_organization_id() AND app.is_authorized_principal()) WITH CHECK (organization_id = app.current_organization_id() AND app.is_authorized_principal())',
      p_table || '_update',
      p_table
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.install_operator_only_rls(p_table text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_tenant_select', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_tenant_write', p_table);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (false)',
    p_table || '_tenant_select',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (false)',
    p_table || '_tenant_write',
    p_table
  );
END;
$$;

SELECT app.install_tenant_owned_rls('crm_organization_profile', true);
SELECT app.install_tenant_owned_rls('crm_user_profile', true);
SELECT app.install_tenant_owned_rls('crm_lifecycle_transition', false);
SELECT app.install_tenant_owned_rls('crm_customer_event', false);
SELECT app.install_tenant_owned_rls('crm_churn_reason', false);
SELECT app.install_tenant_owned_rls('notification_preference', true);
SELECT app.install_tenant_owned_rls('in_app_notification', true);
SELECT app.install_tenant_owned_rls('alert_rule', true);
SELECT app.install_tenant_owned_rls('usage_warning', true);

DROP POLICY IF EXISTS alert_rule_delete ON "alert_rule";
CREATE POLICY alert_rule_delete ON "alert_rule"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

ALTER TABLE "email_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_delivery" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_delivery_select ON "email_delivery";
DROP POLICY IF EXISTS email_delivery_insert ON "email_delivery";
DROP POLICY IF EXISTS email_delivery_update ON "email_delivery";
CREATE POLICY email_delivery_select ON "email_delivery"
  FOR SELECT
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );
CREATE POLICY email_delivery_insert ON "email_delivery"
  FOR INSERT
  WITH CHECK (
    (
      "organization_id" = app.current_organization_id()
      OR "organization_id" IS NULL
    )
    AND app.is_authorized_principal()
  );
CREATE POLICY email_delivery_update ON "email_delivery"
  FOR UPDATE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  )
  WITH CHECK (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

SELECT app.install_operator_only_rls('crm_operator_note');
SELECT app.install_operator_only_rls('crm_tag');
SELECT app.install_operator_only_rls('crm_organization_tag');
SELECT app.install_operator_only_rls('crm_segment_definition');
SELECT app.install_operator_only_rls('crm_segment_membership');
