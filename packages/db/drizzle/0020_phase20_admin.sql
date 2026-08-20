-- Phase 20: platform admin grants, break-glass audit, operator support cases.
-- Platform admin is not a tenant role. Break-glass is audited separately from tenant audit_event.
-- Production still requires APP_ADMIN_PASSWORD for the app_admin connection. No secrets are stored here.

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "granted_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "note" text,
  CONSTRAINT platform_admins_note_chk CHECK (
    "note" IS NULL OR char_length("note") <= 200
  )
);

ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_admins" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_admins_self_select ON "platform_admins";
DROP POLICY IF EXISTS platform_admins_tenant_write ON "platform_admins";
CREATE POLICY platform_admins_self_select ON "platform_admins"
  FOR SELECT
  USING ("user_id" = app.current_user_id());
CREATE POLICY platform_admins_tenant_write ON "platform_admins"
  FOR INSERT
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS "platform_break_glass_audit" (
  "id" text PRIMARY KEY,
  "actor_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE SET NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_break_glass_action_chk CHECK (
    "action" IN (
      'tenant.inspect',
      'creator.exclude',
      'creator.trust',
      'index.upsert',
      'support.case',
      'predictions.preview',
      'health.view'
    )
  )
);

CREATE INDEX IF NOT EXISTS platform_break_glass_audit_created_idx
  ON "platform_break_glass_audit" ("created_at");
CREATE INDEX IF NOT EXISTS platform_break_glass_audit_org_idx
  ON "platform_break_glass_audit" ("organization_id", "created_at");

CREATE OR REPLACE FUNCTION app.forbid_platform_audit_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Platform break-glass audit is append-only.';
END;
$$;

DROP TRIGGER IF EXISTS platform_break_glass_audit_immutable ON "platform_break_glass_audit";
CREATE TRIGGER platform_break_glass_audit_immutable
  BEFORE UPDATE OR DELETE ON "platform_break_glass_audit"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_platform_audit_mutate();

SELECT app.install_operator_only_rls('platform_break_glass_audit');

CREATE TABLE IF NOT EXISTS "platform_support_case" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "body" text NOT NULL,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_support_status_chk CHECK (
    "status" IN ('open', 'pending', 'closed')
  ),
  CONSTRAINT platform_support_subject_chk CHECK (
    char_length("subject") BETWEEN 1 AND 200
  ),
  CONSTRAINT platform_support_body_chk CHECK (
    char_length("body") BETWEEN 1 AND 4000
  )
);

CREATE INDEX IF NOT EXISTS platform_support_case_org_idx
  ON "platform_support_case" ("organization_id", "created_at");

SELECT app.install_operator_only_rls('platform_support_case');
