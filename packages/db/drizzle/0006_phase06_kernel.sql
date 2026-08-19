-- Phase 06: industry-neutral intelligence kernel.
-- No TCG identity, TCC, market data, creators, indices, or predictions.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS source_event_org_id_uidx
  ON "source_event" ("organization_id", "id");

CREATE TABLE IF NOT EXISTS "source_definition" (
  "source_key" text PRIMARY KEY,
  "source_type" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "default_reliability_weight" numeric(5, 4) NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_definition_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT source_definition_weight_chk CHECK (
    "default_reliability_weight" >= 0 AND "default_reliability_weight" <= 1
  )
);

INSERT INTO "source_definition" ("source_key", "source_type", "display_name", "status", "default_reliability_weight")
VALUES
  ('generic_http', 'ingest', 'Generic HTTP ingest', 'active', 1.0000),
  ('ingest', 'ingest', 'Machine ingest namespace', 'active', 1.0000)
ON CONFLICT ("source_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "entity" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "canonical_key" text NOT NULL,
  "display_name" text,
  "status" text NOT NULL DEFAULT 'active',
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_status_chk CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT entity_type_chk CHECK ("entity_type" ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_org_canonical_uidx
  ON "entity" ("organization_id", "canonical_key");
CREATE UNIQUE INDEX IF NOT EXISTS entity_org_id_uidx
  ON "entity" ("organization_id", "id");
CREATE INDEX IF NOT EXISTS entity_org_type_idx
  ON "entity" ("organization_id", "entity_type");

CREATE TABLE IF NOT EXISTS "entity_identifier" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL,
  "source_namespace" text NOT NULL,
  "identifier_type" text NOT NULL,
  "identifier_value" text NOT NULL,
  "normalized_value" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_identifier_org_entity_fk
    FOREIGN KEY ("organization_id", "entity_id") REFERENCES "entity" ("organization_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_identifier_lookup_uidx
  ON "entity_identifier" ("organization_id", "source_namespace", "identifier_type", "normalized_value");
CREATE INDEX IF NOT EXISTS entity_identifier_entity_idx
  ON "entity_identifier" ("organization_id", "entity_id");

CREATE TABLE IF NOT EXISTS "observation" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_id" text,
  "source_event_id" text NOT NULL,
  "source_namespace" text NOT NULL,
  "observation_type" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL,
  "confidence" numeric(5, 4),
  "quality_flag" text,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "supersedes_observation_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observation_org_event_fk
    FOREIGN KEY ("organization_id", "source_event_id") REFERENCES "source_event" ("organization_id", "id"),
  CONSTRAINT observation_org_entity_fk
    FOREIGN KEY ("organization_id", "entity_id") REFERENCES "entity" ("organization_id", "id"),
  CONSTRAINT observation_confidence_chk CHECK (
    "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
  ),
  CONSTRAINT observation_quality_chk CHECK (
    "quality_flag" IS NULL OR "quality_flag" IN ('complete', 'partial', 'stale', 'conflicting', 'suspect')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS observation_org_id_uidx
  ON "observation" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS observation_source_event_uidx
  ON "observation" ("organization_id", "source_event_id");
CREATE INDEX IF NOT EXISTS observation_entity_time_idx
  ON "observation" ("organization_id", "entity_id", "observed_at");
CREATE INDEX IF NOT EXISTS observation_type_time_idx
  ON "observation" ("organization_id", "observation_type", "observed_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'observation_supersedes_fk'
  ) THEN
    ALTER TABLE "observation"
      ADD CONSTRAINT observation_supersedes_fk
      FOREIGN KEY ("organization_id", "supersedes_observation_id")
      REFERENCES "observation" ("organization_id", "id");
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "observation_metric" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "observation_id" text NOT NULL,
  "metric_key" text NOT NULL,
  "numeric_value" numeric(20, 8),
  "text_value" text,
  "unit" text,
  "dimension" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT observation_metric_obs_fk
    FOREIGN KEY ("organization_id", "observation_id") REFERENCES "observation" ("organization_id", "id"),
  CONSTRAINT observation_metric_value_chk CHECK (
    ("numeric_value" IS NOT NULL AND "text_value" IS NULL)
    OR ("numeric_value" IS NULL AND "text_value" IS NOT NULL)
  ),
  CONSTRAINT observation_metric_key_chk CHECK ("metric_key" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS observation_metric_key_uidx
  ON "observation_metric" ("organization_id", "observation_id", "metric_key");
CREATE INDEX IF NOT EXISTS observation_metric_key_idx
  ON "observation_metric" ("organization_id", "metric_key");

CREATE TABLE IF NOT EXISTS "evidence_reference" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "evidence_type" text NOT NULL,
  "source_event_id" text,
  "observation_id" text,
  "external_reference" text,
  "captured_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_type_chk CHECK ("evidence_type" IN ('source_event', 'observation', 'external')),
  CONSTRAINT evidence_org_event_fk
    FOREIGN KEY ("organization_id", "source_event_id") REFERENCES "source_event" ("organization_id", "id"),
  CONSTRAINT evidence_org_obs_fk
    FOREIGN KEY ("organization_id", "observation_id") REFERENCES "observation" ("organization_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_reference_org_id_uidx
  ON "evidence_reference" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS evidence_reference_source_uidx
  ON "evidence_reference" ("organization_id", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "feature_snapshot" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL,
  "feature_set_key" text NOT NULL,
  "feature_set_version" text NOT NULL,
  "features" jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_snapshot_entity_fk
    FOREIGN KEY ("organization_id", "entity_id") REFERENCES "entity" ("organization_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS feature_snapshot_org_id_uidx
  ON "feature_snapshot" ("organization_id", "id");
CREATE INDEX IF NOT EXISTS feature_snapshot_entity_as_of_idx
  ON "feature_snapshot" ("organization_id", "entity_id", "as_of");

CREATE TABLE IF NOT EXISTS "signal" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL,
  "signal_type" text NOT NULL,
  "direction" text NOT NULL DEFAULT 'unknown',
  "magnitude" numeric(20, 8),
  "score" numeric(20, 8),
  "confidence" numeric(5, 4) NOT NULL,
  "valid_from" timestamptz NOT NULL,
  "valid_until" timestamptz,
  "algorithm_key" text NOT NULL,
  "algorithm_version" text NOT NULL,
  "feature_snapshot_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_entity_fk
    FOREIGN KEY ("organization_id", "entity_id") REFERENCES "entity" ("organization_id", "id"),
  CONSTRAINT signal_feature_fk
    FOREIGN KEY ("organization_id", "feature_snapshot_id") REFERENCES "feature_snapshot" ("organization_id", "id"),
  CONSTRAINT signal_confidence_chk CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT signal_direction_chk CHECK ("direction" IN ('up', 'down', 'flat', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS signal_org_id_uidx
  ON "signal" ("organization_id", "id");
CREATE INDEX IF NOT EXISTS signal_type_from_idx
  ON "signal" ("organization_id", "signal_type", "valid_from");
CREATE INDEX IF NOT EXISTS signal_entity_from_idx
  ON "signal" ("organization_id", "entity_id", "valid_from");

CREATE TABLE IF NOT EXISTS "signal_evidence" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "signal_id" text NOT NULL,
  "evidence_reference_id" text NOT NULL,
  "observation_id" text,
  "weight" numeric(5, 4),
  "role" text,
  CONSTRAINT signal_evidence_signal_fk
    FOREIGN KEY ("organization_id", "signal_id") REFERENCES "signal" ("organization_id", "id"),
  CONSTRAINT signal_evidence_ref_fk
    FOREIGN KEY ("organization_id", "evidence_reference_id") REFERENCES "evidence_reference" ("organization_id", "id"),
  CONSTRAINT signal_evidence_obs_fk
    FOREIGN KEY ("organization_id", "observation_id") REFERENCES "observation" ("organization_id", "id"),
  CONSTRAINT signal_evidence_weight_chk CHECK (
    "weight" IS NULL OR ("weight" >= 0 AND "weight" <= 1)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS signal_evidence_link_uidx
  ON "signal_evidence" ("organization_id", "signal_id", "evidence_reference_id");

CREATE TABLE IF NOT EXISTS "decision_record" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL,
  "decision_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "confidence" numeric(5, 4) NOT NULL,
  "policy_key" text NOT NULL,
  "policy_version" text NOT NULL,
  "feature_snapshot_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "finalized_at" timestamptz,
  CONSTRAINT decision_entity_fk
    FOREIGN KEY ("organization_id", "entity_id") REFERENCES "entity" ("organization_id", "id"),
  CONSTRAINT decision_feature_fk
    FOREIGN KEY ("organization_id", "feature_snapshot_id") REFERENCES "feature_snapshot" ("organization_id", "id"),
  CONSTRAINT decision_status_chk CHECK ("status" IN ('draft', 'finalized')),
  CONSTRAINT decision_confidence_chk CHECK ("confidence" >= 0 AND "confidence" <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_record_org_id_uidx
  ON "decision_record" ("organization_id", "id");
CREATE INDEX IF NOT EXISTS decision_record_entity_idx
  ON "decision_record" ("organization_id", "entity_id", "created_at");

CREATE TABLE IF NOT EXISTS "decision_evidence" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "decision_id" text NOT NULL,
  "signal_id" text,
  "evidence_reference_id" text,
  "role" text,
  CONSTRAINT decision_evidence_decision_fk
    FOREIGN KEY ("organization_id", "decision_id") REFERENCES "decision_record" ("organization_id", "id"),
  CONSTRAINT decision_evidence_signal_fk
    FOREIGN KEY ("organization_id", "signal_id") REFERENCES "signal" ("organization_id", "id"),
  CONSTRAINT decision_evidence_ref_fk
    FOREIGN KEY ("organization_id", "evidence_reference_id") REFERENCES "evidence_reference" ("organization_id", "id"),
  CONSTRAINT decision_evidence_target_chk CHECK (
    "signal_id" IS NOT NULL OR "evidence_reference_id" IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_evidence_link_uidx
  ON "decision_evidence" (
    "organization_id",
    "decision_id",
    COALESCE("signal_id", ''),
    COALESCE("evidence_reference_id", '')
  );

CREATE OR REPLACE FUNCTION app.forbid_analytical_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Analytical history is immutable.';
END;
$$;

DROP TRIGGER IF EXISTS observation_immutable ON "observation";
CREATE TRIGGER observation_immutable
  BEFORE UPDATE OR DELETE ON "observation"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS observation_metric_immutable ON "observation_metric";
CREATE TRIGGER observation_metric_immutable
  BEFORE UPDATE OR DELETE ON "observation_metric"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS evidence_reference_immutable ON "evidence_reference";
CREATE TRIGGER evidence_reference_immutable
  BEFORE UPDATE OR DELETE ON "evidence_reference"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS feature_snapshot_immutable ON "feature_snapshot";
CREATE TRIGGER feature_snapshot_immutable
  BEFORE UPDATE OR DELETE ON "feature_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS signal_immutable ON "signal";
CREATE TRIGGER signal_immutable
  BEFORE UPDATE OR DELETE ON "signal"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS signal_evidence_immutable ON "signal_evidence";
CREATE TRIGGER signal_evidence_immutable
  BEFORE UPDATE OR DELETE ON "signal_evidence"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS entity_identifier_immutable ON "entity_identifier";
CREATE TRIGGER entity_identifier_immutable
  BEFORE UPDATE OR DELETE ON "entity_identifier"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

DROP TRIGGER IF EXISTS decision_evidence_immutable ON "decision_evidence";
CREATE TRIGGER decision_evidence_immutable
  BEFORE UPDATE OR DELETE ON "decision_evidence"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytical_mutate();

CREATE OR REPLACE FUNCTION app.protect_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Entities cannot be deleted.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.canonical_key IS DISTINCT FROM OLD.canonical_key
    OR NEW.entity_type IS DISTINCT FROM OLD.entity_type THEN
    RAISE EXCEPTION 'Entity identity fields are immutable.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_protect ON "entity";
CREATE TRIGGER entity_protect
  BEFORE UPDATE OR DELETE ON "entity"
  FOR EACH ROW EXECUTE FUNCTION app.protect_entity();

CREATE OR REPLACE FUNCTION app.protect_decision_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Decision records cannot be deleted.';
  END IF;
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'Finalized decision records are immutable.';
  END IF;
  IF NEW.status = 'finalized' AND OLD.status = 'draft' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
      OR NEW.decision_type IS DISTINCT FROM OLD.decision_type
      OR NEW.result IS DISTINCT FROM OLD.result
      OR NEW.confidence IS DISTINCT FROM OLD.confidence
      OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
      OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
      OR NEW.feature_snapshot_id IS DISTINCT FROM OLD.feature_snapshot_id THEN
      RAISE EXCEPTION 'Finalizing a decision cannot rewrite its payload.';
    END IF;
    NEW.finalized_at := COALESCE(NEW.finalized_at, now());
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal decision_record transition.';
END;
$$;

DROP TRIGGER IF EXISTS decision_record_protect ON "decision_record";
CREATE TRIGGER decision_record_protect
  BEFORE UPDATE OR DELETE ON "decision_record"
  FOR EACH ROW EXECUTE FUNCTION app.protect_decision_record();

CREATE OR REPLACE FUNCTION app.install_kernel_rls(p_table text, p_allow_update boolean)
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

SELECT app.install_kernel_rls('entity', true);
SELECT app.install_kernel_rls('entity_identifier', false);
SELECT app.install_kernel_rls('observation', false);
SELECT app.install_kernel_rls('observation_metric', false);
SELECT app.install_kernel_rls('evidence_reference', false);
SELECT app.install_kernel_rls('feature_snapshot', false);
SELECT app.install_kernel_rls('signal', false);
SELECT app.install_kernel_rls('signal_evidence', false);
SELECT app.install_kernel_rls('decision_record', true);
SELECT app.install_kernel_rls('decision_evidence', false);
