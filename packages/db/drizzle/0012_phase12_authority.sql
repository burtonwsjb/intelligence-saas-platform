-- Phase 12: creator authority and outcome tracking.
-- Append-only slices and trust events. No buy/sell signals. No fabricated Phase 13 indices.

CREATE TABLE IF NOT EXISTS "creator_authority_slice" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL REFERENCES "creator"("id"),
  "game_key" text,
  "language_code" text,
  "era" text NOT NULL DEFAULT 'unspecified',
  "set_key" text,
  "price_tier" text NOT NULL DEFAULT 'unknown',
  "horizon_code" text,
  "raw_graded" text NOT NULL DEFAULT 'raw',
  "sample_size" numeric(12, 0) NOT NULL,
  "successes" numeric(12, 0) NOT NULL,
  "raw_accuracy" numeric(8, 6),
  "recency_weighted_accuracy" numeric(8, 6),
  "wilson_low" numeric(8, 6),
  "wilson_center" numeric(8, 6),
  "wilson_high" numeric(8, 6),
  "bayes_mean" numeric(8, 6),
  "avg_return" numeric(12, 6),
  "median_return" numeric(12, 6),
  "avg_relative_return" numeric(12, 6),
  "avg_mfe" numeric(12, 6),
  "avg_mae" numeric(12, 6),
  "early_call_score" numeric(8, 6),
  "calibration_error" numeric(8, 6),
  "authority_score" numeric(8, 4),
  "authority_weight" numeric(8, 6),
  "trust_state" text NOT NULL,
  "formula_version" text NOT NULL,
  "benchmark_requirement" text NOT NULL,
  "components" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_authority_trust_chk CHECK (
    "trust_state" IN ('trusted', 'reliable', 'developing', 'low_confidence', 'unreliable', 'excluded')
  )
);

CREATE INDEX IF NOT EXISTS creator_authority_slice_creator_idx
  ON "creator_authority_slice" ("creator_id", "created_at");

CREATE TABLE IF NOT EXISTS "creator_trust_event" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL REFERENCES "creator"("id"),
  "trust_state" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_trust_event_state_chk CHECK (
    "trust_state" IN ('trusted', 'reliable', 'developing', 'low_confidence', 'unreliable', 'excluded')
  )
);

CREATE INDEX IF NOT EXISTS creator_trust_event_creator_idx
  ON "creator_trust_event" ("creator_id", "created_at");

DROP TRIGGER IF EXISTS creator_authority_slice_immutable ON "creator_authority_slice";
CREATE TRIGGER creator_authority_slice_immutable
  BEFORE UPDATE OR DELETE ON "creator_authority_slice"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_creator_call_mutate();

DROP TRIGGER IF EXISTS creator_authority_slice_system_write ON "creator_authority_slice";
CREATE TRIGGER creator_authority_slice_system_write
  BEFORE INSERT ON "creator_authority_slice"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();

DROP TRIGGER IF EXISTS creator_trust_event_immutable ON "creator_trust_event";
CREATE TRIGGER creator_trust_event_immutable
  BEFORE UPDATE OR DELETE ON "creator_trust_event"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_creator_call_mutate();

DROP TRIGGER IF EXISTS creator_trust_event_system_write ON "creator_trust_event";
CREATE TRIGGER creator_trust_event_system_write
  BEFORE INSERT ON "creator_trust_event"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_creator_write();
