-- Phase 19: evidence-driven content intelligence and SEO foundation.
-- Public SEO facts are platform-global. Tenant reports are never public SEO.
-- Generation is forbidden without an evidence package. No live LLM required.

CREATE TABLE IF NOT EXISTS "content_candidate" (
  "id" text PRIMARY KEY,
  "output_type" text NOT NULL,
  "printing_id" text REFERENCES "tcg_printing"("id"),
  "language_code" text NOT NULL,
  "comparative" boolean NOT NULL DEFAULT false,
  "as_of" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_candidate_type_chk CHECK (
    "output_type" IN (
      'seo_article', 'market_report', 'card_analysis', 'newsletter', 'email',
      'social_post', 'youtube_outline', 'push_notification', 'tenant_report'
    )
  ),
  CONSTRAINT content_candidate_status_chk CHECK (
    "status" IN ('proposed', 'evidence_ready', 'thin_stub', 'rejected')
  )
);

CREATE INDEX IF NOT EXISTS content_candidate_printing_idx
  ON "content_candidate" ("printing_id", "language_code", "as_of");

CREATE TABLE IF NOT EXISTS "content_evidence_package" (
  "id" text PRIMARY KEY,
  "candidate_id" text NOT NULL REFERENCES "content_candidate"("id"),
  "printing_id" text,
  "language_code" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "recommendation" text NOT NULL,
  "thin" boolean NOT NULL DEFAULT false,
  "comparative" boolean NOT NULL DEFAULT false,
  "snapshot_id" text,
  "score_id" text,
  "prediction_id" text,
  "signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "falsifiers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "identity" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidence_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_evidence_candidate_uidx UNIQUE ("candidate_id")
);

CREATE TABLE IF NOT EXISTS "content_draft" (
  "id" text PRIMARY KEY,
  "candidate_id" text NOT NULL REFERENCES "content_candidate"("id"),
  "evidence_id" text NOT NULL REFERENCES "content_evidence_package"("id"),
  "generator_key" text NOT NULL,
  "generator_version" text NOT NULL,
  "title" text NOT NULL,
  "body_text" text NOT NULL,
  "body_html" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_draft_candidate_idx
  ON "content_draft" ("candidate_id", "created_at");

CREATE TABLE IF NOT EXISTS "content_claim" (
  "id" text PRIMARY KEY,
  "draft_id" text NOT NULL REFERENCES "content_draft"("id"),
  "claim_key" text NOT NULL,
  "numeric_value" numeric(20, 8) NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL
);

CREATE INDEX IF NOT EXISTS content_claim_draft_idx
  ON "content_claim" ("draft_id");

CREATE TABLE IF NOT EXISTS "content_validation" (
  "id" text PRIMARY KEY,
  "draft_id" text NOT NULL REFERENCES "content_draft"("id"),
  "passed" boolean NOT NULL,
  "failures" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "validator_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_validation_draft_uidx UNIQUE ("draft_id")
);

CREATE TABLE IF NOT EXISTS "content_publication" (
  "id" text PRIMARY KEY,
  "draft_id" text NOT NULL REFERENCES "content_draft"("id"),
  "candidate_id" text NOT NULL REFERENCES "content_candidate"("id"),
  "canonical_url" text NOT NULL,
  "robots" text NOT NULL,
  "indexable" boolean NOT NULL DEFAULT false,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  "approved_by" text,
  "status" text NOT NULL DEFAULT 'approved',
  CONSTRAINT content_publication_draft_uidx UNIQUE ("draft_id"),
  CONSTRAINT content_publication_url_uidx UNIQUE ("canonical_url"),
  CONSTRAINT content_publication_robots_chk CHECK ("robots" IN ('index', 'noindex')),
  CONSTRAINT content_publication_status_chk CHECK ("status" IN ('approved', 'published'))
);

CREATE UNIQUE INDEX IF NOT EXISTS content_publication_indexable_printing_uidx
  ON "content_publication" ("candidate_id")
  WHERE "indexable" = true;

CREATE TABLE IF NOT EXISTS "tenant_content_report" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "output_type" text NOT NULL DEFAULT 'tenant_report',
  "title" text NOT NULL,
  "body_text" text NOT NULL,
  "holdings" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "public_seo" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_content_report_seo_chk CHECK ("public_seo" = false),
  CONSTRAINT tenant_content_report_type_chk CHECK ("output_type" = 'tenant_report')
);

CREATE INDEX IF NOT EXISTS tenant_content_report_org_idx
  ON "tenant_content_report" ("organization_id", "created_at");

SELECT app.install_tenant_owned_rls('tenant_content_report', false);

DROP TRIGGER IF EXISTS content_candidate_system_write ON "content_candidate";
CREATE TRIGGER content_candidate_system_write
  BEFORE INSERT ON "content_candidate"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_candidate_immutable ON "content_candidate";
CREATE TRIGGER content_candidate_immutable
  BEFORE UPDATE OR DELETE ON "content_candidate"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS content_evidence_system_write ON "content_evidence_package";
CREATE TRIGGER content_evidence_system_write
  BEFORE INSERT ON "content_evidence_package"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_evidence_immutable ON "content_evidence_package";
CREATE TRIGGER content_evidence_immutable
  BEFORE UPDATE OR DELETE ON "content_evidence_package"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS content_draft_system_write ON "content_draft";
CREATE TRIGGER content_draft_system_write
  BEFORE INSERT ON "content_draft"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_draft_immutable ON "content_draft";
CREATE TRIGGER content_draft_immutable
  BEFORE UPDATE OR DELETE ON "content_draft"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS content_claim_system_write ON "content_claim";
CREATE TRIGGER content_claim_system_write
  BEFORE INSERT ON "content_claim"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_claim_immutable ON "content_claim";
CREATE TRIGGER content_claim_immutable
  BEFORE UPDATE OR DELETE ON "content_claim"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS content_validation_system_write ON "content_validation";
CREATE TRIGGER content_validation_system_write
  BEFORE INSERT ON "content_validation"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_validation_immutable ON "content_validation";
CREATE TRIGGER content_validation_immutable
  BEFORE UPDATE OR DELETE ON "content_validation"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS content_publication_system_write ON "content_publication";
CREATE TRIGGER content_publication_system_write
  BEFORE INSERT ON "content_publication"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS content_publication_immutable ON "content_publication";
CREATE TRIGGER content_publication_immutable
  BEFORE UPDATE OR DELETE ON "content_publication"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();
