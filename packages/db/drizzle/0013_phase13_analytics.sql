-- Phase 13: collectible-aware market analytics, generalized indices, benchmarks, and creator alpha.
-- Platform-global. No tenant RLS. No buy/sell recommendations. No look-ahead.

CREATE TABLE IF NOT EXISTS "tcg_market_feature_snapshot" (
  "id" text PRIMARY KEY,
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "as_of" timestamptz NOT NULL,
  "feature_set_key" text NOT NULL,
  "feature_set_version" text NOT NULL,
  "condition" text NOT NULL DEFAULT 'nm',
  "grading_company" text,
  "grade_label" text,
  "language_code" text NOT NULL,
  "currency" text NOT NULL,
  "outlier_policy" text NOT NULL,
  "features" jsonb NOT NULL,
  "data_quality" text NOT NULL,
  "sample_size" integer NOT NULL,
  "coverage" numeric(8, 6),
  "staleness_hours" numeric(12, 4),
  "source_composition" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_market_feature_quality_chk CHECK (
    "data_quality" IN ('complete', 'partial', 'insufficient_data', 'stale', 'outlier_dependent')
  ),
  CONSTRAINT tcg_market_feature_outlier_chk CHECK (
    "outlier_policy" IN ('exclude_flagged.v1', 'include_all.v1')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_market_feature_snapshot_uidx
  ON "tcg_market_feature_snapshot" (
    "printing_id", "as_of", "feature_set_key", "feature_set_version",
    "condition", "outlier_policy", COALESCE("grading_company", ''), COALESCE("grade_label", '')
  );
CREATE INDEX IF NOT EXISTS tcg_market_feature_snapshot_printing_asof_idx
  ON "tcg_market_feature_snapshot" ("printing_id", "as_of");

CREATE TABLE IF NOT EXISTS "tcg_index_definition" (
  "index_key" text PRIMARY KEY,
  "name" text NOT NULL,
  "game_key" text NOT NULL,
  "language_code" text,
  "membership_rule" jsonb NOT NULL,
  "weighting_method" text NOT NULL,
  "min_liquidity" integer NOT NULL DEFAULT 1,
  "min_history" integer NOT NULL DEFAULT 1,
  "rebalance_schedule" text NOT NULL DEFAULT 'manual',
  "method_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_index_weighting_chk CHECK ("weighting_method" IN ('equal.v1', 'liquidity.v1')),
  CONSTRAINT tcg_index_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_index_rebalance_chk CHECK ("rebalance_schedule" IN ('daily', 'weekly', 'monthly', 'manual'))
);

-- Example definitions, not a closed catalog. Operators may add more keys.
INSERT INTO "tcg_index_definition" (
  "index_key", "name", "game_key", "language_code", "membership_rule",
  "weighting_method", "min_liquidity", "min_history", "rebalance_schedule", "method_version", "status"
)
VALUES
  ('pokemon.language.en', 'English Pokémon Index', 'pokemon', 'en',
    '{"game_key":"pokemon","language_code":"en","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.language.ja', 'Japanese Pokémon Index', 'pokemon', 'ja',
    '{"game_key":"pokemon","language_code":"ja","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.language.zh-Hans', 'Simplified Chinese Pokémon Index', 'pokemon', 'zh-Hans',
    '{"game_key":"pokemon","language_code":"zh-Hans","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.modern.en', 'Modern English Pokémon Index', 'pokemon', 'en',
    '{"game_key":"pokemon","language_code":"en","era":"modern","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.concept.pikachu.en', 'Pikachu Index (English)', 'pokemon', 'en',
    '{"game_key":"pokemon","language_code":"en","concept_key":"pikachu","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.concept.charizard.en', 'Charizard Index (English)', 'pokemon', 'en',
    '{"game_key":"pokemon","language_code":"en","concept_key":"charizard-ex","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('pokemon.grade.psa10.en', 'PSA 10 Index (English)', 'pokemon', 'en',
    '{"game_key":"pokemon","language_code":"en","raw_graded":"psa10","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active'),
  ('one_piece.language.en', 'English One Piece Index', 'one_piece', 'en',
    '{"game_key":"one_piece","language_code":"en","raw_graded":"raw","condition":"nm","min_sales_30d":1,"min_history_observations":1}'::jsonb,
    'equal.v1', 1, 1, 'manual', 'index.v1', 'active')
ON CONFLICT ("index_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "tcg_index_membership" (
  "id" text PRIMARY KEY,
  "index_key" text NOT NULL REFERENCES "tcg_index_definition"("index_key"),
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "weight" numeric(12, 8) NOT NULL,
  "method_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_index_membership_range_chk CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_index_membership_open_uidx
  ON "tcg_index_membership" ("index_key", "printing_id", "effective_from");
CREATE INDEX IF NOT EXISTS tcg_index_membership_asof_idx
  ON "tcg_index_membership" ("index_key", "effective_from", "effective_to");

CREATE TABLE IF NOT EXISTS "tcg_index_level" (
  "id" text PRIMARY KEY,
  "index_key" text NOT NULL REFERENCES "tcg_index_definition"("index_key"),
  "observed_at" timestamptz NOT NULL,
  "index_value" numeric(20, 8) NOT NULL,
  "component_count" integer NOT NULL,
  "priced_count" integer NOT NULL,
  "coverage" numeric(8, 6) NOT NULL,
  "data_quality" text NOT NULL,
  "method_version" text NOT NULL,
  "weighting_method" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_index_level_quality_chk CHECK (
    "data_quality" IN ('complete', 'partial', 'insufficient_data', 'stale', 'outlier_dependent')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_index_level_point_uidx
  ON "tcg_index_level" ("index_key", "observed_at", "method_version");
CREATE INDEX IF NOT EXISTS tcg_index_level_time_idx
  ON "tcg_index_level" ("index_key", "observed_at");

CREATE TABLE IF NOT EXISTS "creator_call_alpha" (
  "id" text PRIMARY KEY,
  "call_id" text NOT NULL REFERENCES "creator_call"("id"),
  "method_version" text NOT NULL,
  "card_return" numeric(12, 6),
  "benchmark_index_key" text,
  "benchmark_return" numeric(12, 6),
  "relative_return" numeric(12, 6),
  "benchmark_level_at_call" numeric(20, 8),
  "benchmark_level_at_horizon" numeric(20, 8),
  "data_quality" text NOT NULL,
  "components" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_call_alpha_call_method_uidx
  ON "creator_call_alpha" ("call_id", "method_version");

CREATE OR REPLACE FUNCTION app.forbid_analytics_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Analytics history is immutable.';
END;
$$;

CREATE OR REPLACE FUNCTION app.require_system_analytics_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Analytics facts can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.close_index_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Analytics history is immutable.';
  END IF;
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'Analytics facts can only be written by the system principal.';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.index_key IS DISTINCT FROM OLD.index_key
     OR NEW.printing_id IS DISTINCT FROM OLD.printing_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.weight IS DISTINCT FROM OLD.weight
     OR NEW.method_version IS DISTINCT FROM OLD.method_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Analytics history is immutable.';
  END IF;
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'Analytics history is immutable.';
  END IF;
  IF NEW.effective_to IS NULL OR NEW.effective_to <= OLD.effective_from THEN
    RAISE EXCEPTION 'Analytics history is immutable.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tcg_market_feature_snapshot_immutable ON "tcg_market_feature_snapshot";
CREATE TRIGGER tcg_market_feature_snapshot_immutable
  BEFORE UPDATE OR DELETE ON "tcg_market_feature_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_market_feature_snapshot_system_write ON "tcg_market_feature_snapshot";
CREATE TRIGGER tcg_market_feature_snapshot_system_write
  BEFORE INSERT ON "tcg_market_feature_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS tcg_index_definition_system_write ON "tcg_index_definition";
CREATE TRIGGER tcg_index_definition_system_write
  BEFORE INSERT ON "tcg_index_definition"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS tcg_index_membership_system_write ON "tcg_index_membership";
CREATE TRIGGER tcg_index_membership_system_write
  BEFORE INSERT ON "tcg_index_membership"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS tcg_index_membership_close ON "tcg_index_membership";
CREATE TRIGGER tcg_index_membership_close
  BEFORE UPDATE OR DELETE ON "tcg_index_membership"
  FOR EACH ROW EXECUTE FUNCTION app.close_index_membership();

DROP TRIGGER IF EXISTS tcg_index_level_immutable ON "tcg_index_level";
CREATE TRIGGER tcg_index_level_immutable
  BEFORE UPDATE OR DELETE ON "tcg_index_level"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_index_level_system_write ON "tcg_index_level";
CREATE TRIGGER tcg_index_level_system_write
  BEFORE INSERT ON "tcg_index_level"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS creator_call_alpha_immutable ON "creator_call_alpha";
CREATE TRIGGER creator_call_alpha_immutable
  BEFORE UPDATE OR DELETE ON "creator_call_alpha"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS creator_call_alpha_system_write ON "creator_call_alpha";
CREATE TRIGGER creator_call_alpha_system_write
  BEFORE INSERT ON "creator_call_alpha"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();
