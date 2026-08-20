-- Phase 22: controlled beta readiness (invites, flags, cohorts, onboarding, feedback).
-- Predictions remain shadow unless an explicit platform flag is enabled. No production onboarding implied.

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
    'feature.flag'
  )
);

CREATE TABLE IF NOT EXISTS "platform_feature_flags" (
  "flag_key" text PRIMARY KEY,
  "enabled" boolean NOT NULL DEFAULT false,
  "description" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT platform_feature_flags_key_chk CHECK (
    "flag_key" IN (
      'predictions_customer_visible',
      'content_publication',
      'creator_intelligence',
      'webhooks',
      'beta_only_features'
    )
  )
);

INSERT INTO "platform_feature_flags" ("flag_key", "enabled", "description")
VALUES
  ('predictions_customer_visible', false, 'Customer-facing predictions. Shadow remains the default.'),
  ('content_publication', false, 'Public content publication pipeline.'),
  ('creator_intelligence', true, 'Creator intelligence surfaces.'),
  ('webhooks', true, 'Tenant webhook endpoints.'),
  ('beta_only_features', true, 'Beta-only product surfaces.')
ON CONFLICT ("flag_key") DO NOTHING;

ALTER TABLE "platform_feature_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_feature_flags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_feature_flags_select ON "platform_feature_flags";
DROP POLICY IF EXISTS platform_feature_flags_write ON "platform_feature_flags";
CREATE POLICY platform_feature_flags_select ON "platform_feature_flags"
  FOR SELECT USING (true);
CREATE POLICY platform_feature_flags_write ON "platform_feature_flags"
  FOR INSERT WITH CHECK (false);

CREATE TABLE IF NOT EXISTS "beta_invitation" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE,
  "email" text,
  "organization_hint" text,
  "cohort" text NOT NULL DEFAULT 'beta_wave_1',
  "expires_at" timestamptz NOT NULL,
  "max_uses" integer NOT NULL DEFAULT 1,
  "use_count" integer NOT NULL DEFAULT 0,
  "used_at" timestamptz,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beta_invitation_cohort_chk CHECK (
    "cohort" IN ('internal', 'alpha', 'beta_wave_1', 'beta_wave_2')
  ),
  CONSTRAINT beta_invitation_uses_chk CHECK ("max_uses" >= 1 AND "max_uses" <= 100),
  CONSTRAINT beta_invitation_count_chk CHECK ("use_count" >= 0 AND "use_count" <= "max_uses")
);

CREATE INDEX IF NOT EXISTS beta_invitation_expires_idx ON "beta_invitation" ("expires_at");

SELECT app.install_operator_only_rls('beta_invitation');

CREATE OR REPLACE FUNCTION app.consume_beta_invite(p_token_hash text, p_email text)
RETURNS TABLE (
  invite_id text,
  cohort text,
  organization_hint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  rec "beta_invitation"%ROWTYPE;
BEGIN
  SELECT * INTO rec
  FROM "beta_invitation"
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Beta invitation is invalid.';
  END IF;
  IF rec.expires_at <= now() THEN
    RAISE EXCEPTION 'Beta invitation has expired.';
  END IF;
  IF rec.use_count >= rec.max_uses THEN
    RAISE EXCEPTION 'Beta invitation has no remaining uses.';
  END IF;
  IF rec.email IS NOT NULL AND p_email IS NOT NULL
     AND lower(rec.email) <> lower(p_email) THEN
    RAISE EXCEPTION 'Beta invitation email does not match.';
  END IF;
  UPDATE "beta_invitation"
  SET use_count = rec.use_count + 1,
      used_at = now()
  WHERE id = rec.id;
  invite_id := rec.id;
  cohort := rec.cohort;
  organization_hint := rec.organization_hint;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION app.consume_beta_invite(text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION app.consume_beta_invite(text, text) TO app_user, app_worker, app_migrate, app_admin;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "beta_organization" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "cohort" text NOT NULL DEFAULT 'internal',
  "use_case" text,
  "onboarding" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beta_organization_cohort_chk CHECK (
    "cohort" IN ('internal', 'alpha', 'beta_wave_1', 'beta_wave_2')
  )
);

SELECT app.install_tenant_owned_rls('beta_organization', true);

CREATE TABLE IF NOT EXISTS "product_feedback" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "category" text NOT NULL,
  "page_context" text,
  "severity" text NOT NULL DEFAULT 'normal',
  "message" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "support_case_id" text REFERENCES "platform_support_case"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_feedback_category_chk CHECK (
    "category" IN ('product', 'intelligence', 'billing', 'api', 'other')
  ),
  CONSTRAINT product_feedback_severity_chk CHECK (
    "severity" IN ('low', 'normal', 'high', 'blocker')
  ),
  CONSTRAINT product_feedback_status_chk CHECK (
    "status" IN ('open', 'acknowledged', 'closed')
  ),
  CONSTRAINT product_feedback_message_chk CHECK (char_length("message") BETWEEN 8 AND 4000)
);

CREATE INDEX IF NOT EXISTS product_feedback_org_idx ON "product_feedback" ("organization_id", "created_at");
SELECT app.install_tenant_owned_rls('product_feedback', true);

CREATE TABLE IF NOT EXISTS "bug_report" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "request_id" text,
  "route" text,
  "browser" text,
  "description" text NOT NULL,
  "reproduction" text,
  "status" text NOT NULL DEFAULT 'open',
  "support_case_id" text REFERENCES "platform_support_case"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bug_report_status_chk CHECK ("status" IN ('open', 'acknowledged', 'closed')),
  CONSTRAINT bug_report_description_chk CHECK (char_length("description") BETWEEN 8 AND 4000)
);

CREATE INDEX IF NOT EXISTS bug_report_org_idx ON "bug_report" ("organization_id", "created_at");
SELECT app.install_tenant_owned_rls('bug_report', true);

CREATE TABLE IF NOT EXISTS "product_event" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "event_name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_event_name_chk CHECK (
    "event_name" IN (
      'dashboard.viewed',
      'opportunity.opened',
      'creator.viewed',
      'api_key.created',
      'webhook.created',
      'alert.created',
      'content.viewed'
    )
  )
);

CREATE INDEX IF NOT EXISTS product_event_org_idx ON "product_event" ("organization_id", "created_at");
SELECT app.install_tenant_owned_rls('product_event', false);
