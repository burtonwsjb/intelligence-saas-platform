-- Phase 10: advanced entity resolution.
-- Platform-global candidates and immutable attempt history. No tenant RLS.
-- Resolution confidence is not market, creator-authority, or sentiment confidence.

CREATE TABLE IF NOT EXISTS "tcg_card_name_alias" (
  "id" text PRIMARY KEY,
  "card_id" text NOT NULL REFERENCES "tcg_card_concept"("id"),
  "language_code" text NOT NULL REFERENCES "tcg_language"("language_code"),
  "name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_card_name_alias_uidx
  ON "tcg_card_name_alias" ("card_id", "language_code", "normalized_name");
CREATE INDEX IF NOT EXISTS tcg_card_name_alias_name_idx
  ON "tcg_card_name_alias" ("normalized_name");

CREATE TABLE IF NOT EXISTS "entity_resolution_attempt" (
  "id" text PRIMARY KEY,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "mention_id" text REFERENCES "source_mention"("id"),
  "target_layer" text NOT NULL,
  "status" text NOT NULL,
  "chosen_printing_id" text REFERENCES "tcg_printing"("id"),
  "chosen_concept_id" text REFERENCES "tcg_card_concept"("id"),
  "chosen_entity_id" text,
  "confidence" numeric(5, 4),
  "resolver_version" text NOT NULL,
  "review_state" text NOT NULL DEFAULT 'none',
  "input_signals" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_resolution_subject_chk CHECK (
    "subject_type" IN ('mention', 'provider_reference', 'manual')
  ),
  CONSTRAINT entity_resolution_layer_chk CHECK (
    "target_layer" IN ('printing', 'concept', 'generic_entity')
  ),
  CONSTRAINT entity_resolution_status_chk CHECK (
    "status" IN ('exact', 'high_confidence', 'probable', 'ambiguous', 'unresolved', 'conflict')
  ),
  CONSTRAINT entity_resolution_review_chk CHECK (
    "review_state" IN ('none', 'needs_review', 'accepted', 'rejected', 'unresolved_confirmed')
  ),
  CONSTRAINT entity_resolution_chosen_printing_chk CHECK (
    (
      "status" IN ('exact', 'high_confidence')
      AND "chosen_printing_id" IS NOT NULL
    )
    OR (
      "status" NOT IN ('exact', 'high_confidence')
      AND "chosen_printing_id" IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS entity_resolution_subject_idx
  ON "entity_resolution_attempt" ("subject_type", "subject_id", "created_at");
CREATE INDEX IF NOT EXISTS entity_resolution_mention_idx
  ON "entity_resolution_attempt" ("mention_id", "created_at");

CREATE TABLE IF NOT EXISTS "entity_resolution_candidate" (
  "id" text PRIMARY KEY,
  "attempt_id" text NOT NULL REFERENCES "entity_resolution_attempt"("id"),
  "printing_id" text REFERENCES "tcg_printing"("id"),
  "concept_id" text REFERENCES "tcg_card_concept"("id"),
  "entity_id" text,
  "score" numeric(12, 4) NOT NULL,
  "rank" integer NOT NULL,
  "matched_attributes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "conflicting_attributes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_resolution_candidate_attempt_idx
  ON "entity_resolution_candidate" ("attempt_id", "rank");

CREATE TABLE IF NOT EXISTS "entity_resolution_correction" (
  "id" text PRIMARY KEY,
  "source_attempt_id" text NOT NULL REFERENCES "entity_resolution_attempt"("id"),
  "result_attempt_id" text NOT NULL REFERENCES "entity_resolution_attempt"("id"),
  "action" text NOT NULL,
  "candidate_id" text REFERENCES "entity_resolution_candidate"("id"),
  "printing_id" text REFERENCES "tcg_printing"("id"),
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_resolution_correction_action_chk CHECK (
    "action" IN ('accept_candidate', 'reject_candidate', 'mark_unresolved', 'correct_mapping')
  )
);

CREATE INDEX IF NOT EXISTS entity_resolution_correction_source_idx
  ON "entity_resolution_correction" ("source_attempt_id");

CREATE OR REPLACE FUNCTION app.forbid_resolution_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Entity resolution history is immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION app.require_system_resolution_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Entity resolution can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tcg_card_name_alias_immutable ON "tcg_card_name_alias";
CREATE TRIGGER tcg_card_name_alias_immutable
  BEFORE UPDATE OR DELETE ON "tcg_card_name_alias"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS entity_resolution_attempt_immutable ON "entity_resolution_attempt";
CREATE TRIGGER entity_resolution_attempt_immutable
  BEFORE UPDATE OR DELETE ON "entity_resolution_attempt"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_resolution_mutate();

DROP TRIGGER IF EXISTS entity_resolution_attempt_system_write ON "entity_resolution_attempt";
CREATE TRIGGER entity_resolution_attempt_system_write
  BEFORE INSERT ON "entity_resolution_attempt"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_resolution_write();

DROP TRIGGER IF EXISTS entity_resolution_candidate_immutable ON "entity_resolution_candidate";
CREATE TRIGGER entity_resolution_candidate_immutable
  BEFORE UPDATE OR DELETE ON "entity_resolution_candidate"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_resolution_mutate();

DROP TRIGGER IF EXISTS entity_resolution_candidate_system_write ON "entity_resolution_candidate";
CREATE TRIGGER entity_resolution_candidate_system_write
  BEFORE INSERT ON "entity_resolution_candidate"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_resolution_write();

DROP TRIGGER IF EXISTS entity_resolution_correction_immutable ON "entity_resolution_correction";
CREATE TRIGGER entity_resolution_correction_immutable
  BEFORE UPDATE OR DELETE ON "entity_resolution_correction"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_resolution_mutate();

DROP TRIGGER IF EXISTS entity_resolution_correction_system_write ON "entity_resolution_correction";
CREATE TRIGGER entity_resolution_correction_system_write
  BEFORE INSERT ON "entity_resolution_correction"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_resolution_write();
