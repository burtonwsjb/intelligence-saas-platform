-- Phase 11: creator call extraction.
-- Platform-global creators and immutable calls. No tenant RLS.
-- No authority scoring. No production LLM calls.

CREATE TABLE IF NOT EXISTS "creator" (
  "id" text PRIMARY KEY,
  "display_name" text,
  "status" text NOT NULL DEFAULT 'active',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_status_chk CHECK ("status" IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS "creator_source_account" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL REFERENCES "creator"("id"),
  "source_account_id" text NOT NULL REFERENCES "source_account"("id"),
  "link_state" text NOT NULL DEFAULT 'unresolved_ownership',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_source_link_chk CHECK (
    "link_state" IN ('confirmed', 'unresolved_ownership')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_source_account_uidx
  ON "creator_source_account" ("source_account_id");
CREATE INDEX IF NOT EXISTS creator_source_account_creator_idx
  ON "creator_source_account" ("creator_id");

CREATE TABLE IF NOT EXISTS "creator_call" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL REFERENCES "creator"("id"),
  "source_account_id" text NOT NULL REFERENCES "source_account"("id"),
  "content_id" text NOT NULL REFERENCES "source_content"("id"),
  "segment_id" text REFERENCES "source_content_segment"("id"),
  "mention_id" text REFERENCES "source_mention"("id"),
  "published_at" timestamptz NOT NULL,
  "printing_id" text REFERENCES "tcg_printing"("id"),
  "concept_id" text REFERENCES "tcg_card_concept"("id"),
  "resolution_attempt_id" text REFERENCES "entity_resolution_attempt"("id"),
  "resolution_status" text NOT NULL,
  "resolution_confidence" numeric(5, 4),
  "price_at_call" numeric(20, 8),
  "price_currency" text,
  "price_source" text,
  "price_observed_at" timestamptz,
  "price_method_version" text,
  "direction" text NOT NULL,
  "target_price" numeric(20, 8),
  "target_percent" numeric(12, 6),
  "horizon_code" text NOT NULL DEFAULT 'unspecified',
  "horizon_custom_days" numeric(10, 2),
  "stated_confidence" numeric(5, 4),
  "extraction_confidence" numeric(5, 4) NOT NULL,
  "extraction_version" text NOT NULL,
  "fingerprint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'finalized',
  "revises_call_id" text REFERENCES "creator_call"("id"),
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_call_direction_chk CHECK (
    "direction" IN ('bullish', 'bearish', 'neutral', 'watch', 'avoid', 'unknown')
  ),
  CONSTRAINT creator_call_horizon_chk CHECK (
    "horizon_code" IN ('7d', '30d', '90d', '180d', '365d', 'custom', 'unspecified')
  ),
  CONSTRAINT creator_call_status_chk CHECK (
    "status" IN ('extracted', 'finalized', 'superseded')
  ),
  CONSTRAINT creator_call_printing_bind_chk CHECK (
    (
      "resolution_status" IN ('exact', 'high_confidence')
      AND "printing_id" IS NOT NULL
    )
    OR (
      "resolution_status" NOT IN ('exact', 'high_confidence')
      AND "printing_id" IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_call_fingerprint_uidx ON "creator_call" ("fingerprint");
CREATE INDEX IF NOT EXISTS creator_call_creator_idx ON "creator_call" ("creator_id", "published_at");
CREATE INDEX IF NOT EXISTS creator_call_printing_idx ON "creator_call" ("printing_id", "published_at");
CREATE INDEX IF NOT EXISTS creator_call_direction_idx ON "creator_call" ("direction", "published_at");

CREATE TABLE IF NOT EXISTS "creator_call_outcome" (
  "id" text PRIMARY KEY,
  "call_id" text NOT NULL REFERENCES "creator_call"("id"),
  "evaluation_status" text NOT NULL DEFAULT 'pending',
  "starting_price" numeric(20, 8),
  "ending_price" numeric(20, 8),
  "return_pct" numeric(12, 6),
  "directional_correct" text,
  "target_hit" text,
  "max_favorable_excursion" numeric(12, 6),
  "max_adverse_excursion" numeric(12, 6),
  "data_quality" text,
  "evaluated_at" timestamptz,
  "method_version" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_call_outcome_status_chk CHECK (
    "evaluation_status" IN ('pending', 'ready', 'evaluated', 'insufficient_data')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_call_outcome_call_uidx ON "creator_call_outcome" ("call_id");

CREATE OR REPLACE FUNCTION app.forbid_creator_call_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Creator calls are immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION app.require_system_creator_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Creator intelligence can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS creator_call_immutable ON "creator_call";
CREATE TRIGGER creator_call_immutable
  BEFORE UPDATE OR DELETE ON "creator_call"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_creator_call_mutate();

DROP TRIGGER IF EXISTS creator_call_system_write ON "creator_call";
CREATE TRIGGER creator_call_system_write
  BEFORE INSERT ON "creator_call"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();

DROP TRIGGER IF EXISTS creator_call_outcome_system_write ON "creator_call_outcome";
CREATE TRIGGER creator_call_outcome_system_write
  BEFORE INSERT ON "creator_call_outcome"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();

DROP TRIGGER IF EXISTS creator_system_write ON "creator";
CREATE TRIGGER creator_system_write
  BEFORE INSERT ON "creator"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();

DROP TRIGGER IF EXISTS creator_source_account_system_write ON "creator_source_account";
CREATE TRIGGER creator_source_account_system_write
  BEFORE INSERT ON "creator_source_account"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();
