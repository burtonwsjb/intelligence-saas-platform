-- Phase 15: versioned probabilistic forecasts, outcomes, calibration, walk-forward backtests.
-- Default visibility is shadow. No look-ahead. Bad forecasts are retained.

CREATE TABLE IF NOT EXISTS "tcg_prediction" (
  "id" text PRIMARY KEY,
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "issued_at" timestamptz NOT NULL,
  "data_cutoff_at" timestamptz NOT NULL,
  "horizon" text NOT NULL,
  "model_key" text NOT NULL,
  "model_version" text NOT NULL,
  "feature_snapshot_id" text REFERENCES "tcg_market_feature_snapshot"("id"),
  "feature_set_version" text,
  "score_version" text,
  "visibility" text NOT NULL DEFAULT 'shadow',
  "status" text NOT NULL DEFAULT 'issued',
  "language_code" text NOT NULL,
  "price_at_issue" numeric(20, 8),
  "expected_return" numeric(12, 6),
  "return_range_low" numeric(12, 6),
  "return_range_high" numeric(12, 6),
  "price_range_low" numeric(20, 8),
  "price_range_high" numeric(20, 8),
  "probability_increase" numeric(8, 6),
  "probability_decline" numeric(8, 6),
  "confidence" numeric(8, 4),
  "risk" numeric(8, 4),
  "data_quality" text NOT NULL,
  "components" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_prediction_horizon_chk CHECK ("horizon" IN ('7d', '30d', '90d', '180d', '365d')),
  CONSTRAINT tcg_prediction_visibility_chk CHECK ("visibility" IN ('shadow', 'internal', 'published')),
  CONSTRAINT tcg_prediction_status_chk CHECK ("status" IN ('issued', 'evaluated', 'insufficient_data')),
  CONSTRAINT tcg_prediction_cutoff_chk CHECK ("data_cutoff_at" <= "issued_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_prediction_issue_uidx
  ON "tcg_prediction" ("printing_id", "issued_at", "horizon", "model_version");
CREATE INDEX IF NOT EXISTS tcg_prediction_printing_idx
  ON "tcg_prediction" ("printing_id", "issued_at");

CREATE TABLE IF NOT EXISTS "tcg_prediction_outcome" (
  "id" text PRIMARY KEY,
  "prediction_id" text NOT NULL REFERENCES "tcg_prediction"("id"),
  "evaluated_at" timestamptz NOT NULL,
  "actual_price" numeric(20, 8),
  "actual_return" numeric(12, 6),
  "directional_accuracy" text,
  "forecast_error" numeric(12, 6),
  "abs_error" numeric(12, 6),
  "range_hit" text,
  "brier_score" numeric(12, 6),
  "benchmark_return" numeric(12, 6),
  "alpha" numeric(12, 6),
  "drawdown" numeric(12, 6),
  "calibration_version" text NOT NULL,
  "data_quality" text NOT NULL,
  "components" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_prediction_outcome_range_chk CHECK ("range_hit" IS NULL OR "range_hit" IN ('hit', 'miss')),
  CONSTRAINT tcg_prediction_outcome_direction_chk CHECK (
    "directional_accuracy" IS NULL OR "directional_accuracy" IN ('correct', 'incorrect')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_prediction_outcome_prediction_uidx
  ON "tcg_prediction_outcome" ("prediction_id");

CREATE TABLE IF NOT EXISTS "tcg_backtest_run" (
  "id" text PRIMARY KEY,
  "model_version" text NOT NULL,
  "method_version" text NOT NULL,
  "calibration_window_end" timestamptz,
  "evaluation_window_start" timestamptz NOT NULL,
  "evaluation_window_end" timestamptz NOT NULL,
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS tcg_prediction_immutable ON "tcg_prediction";
CREATE TRIGGER tcg_prediction_immutable
  BEFORE UPDATE OR DELETE ON "tcg_prediction"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_prediction_system_write ON "tcg_prediction";
CREATE TRIGGER tcg_prediction_system_write
  BEFORE INSERT ON "tcg_prediction"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS tcg_prediction_outcome_immutable ON "tcg_prediction_outcome";
CREATE TRIGGER tcg_prediction_outcome_immutable
  BEFORE UPDATE OR DELETE ON "tcg_prediction_outcome"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_prediction_outcome_system_write ON "tcg_prediction_outcome";
CREATE TRIGGER tcg_prediction_outcome_system_write
  BEFORE INSERT ON "tcg_prediction_outcome"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();

DROP TRIGGER IF EXISTS tcg_backtest_run_immutable ON "tcg_backtest_run";
CREATE TRIGGER tcg_backtest_run_immutable
  BEFORE UPDATE OR DELETE ON "tcg_backtest_run"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_backtest_run_system_write ON "tcg_backtest_run";
CREATE TRIGGER tcg_backtest_run_system_write
  BEFORE INSERT ON "tcg_backtest_run"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();
