-- Phase 14: explainable opportunity / risk / confidence / liquidity scores and recommendations.
-- Platform-global score snapshots. Tenant decision_record is the Phase 06 evidence projection.
-- Weights are uncalibrated v1. No hidden missing-value substitution. Hype cannot Strong Buy.

CREATE TABLE IF NOT EXISTS "tcg_score_snapshot" (
  "id" text PRIMARY KEY,
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "as_of" timestamptz NOT NULL,
  "score_version" text NOT NULL,
  "policy_key" text NOT NULL,
  "policy_version" text NOT NULL,
  "recommendation_version" text NOT NULL,
  "feature_snapshot_id" text REFERENCES "tcg_market_feature_snapshot"("id"),
  "opportunity_score" numeric(8, 4) NOT NULL,
  "risk_score" numeric(8, 4) NOT NULL,
  "confidence_score" numeric(8, 4) NOT NULL,
  "liquidity_score" numeric(8, 4) NOT NULL,
  "recommendation" text NOT NULL,
  "uncalibrated" text NOT NULL DEFAULT 'true',
  "data_quality" text NOT NULL,
  "language_code" text NOT NULL,
  "components" jsonb NOT NULL,
  "explanations" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_score_recommendation_chk CHECK (
    "recommendation" IN (
      'strong_buy', 'buy', 'watch', 'hold', 'reduce', 'sell', 'strong_sell', 'insufficient_data'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_score_snapshot_version_uidx
  ON "tcg_score_snapshot" ("printing_id", "as_of", "score_version");
CREATE INDEX IF NOT EXISTS tcg_score_snapshot_printing_asof_idx
  ON "tcg_score_snapshot" ("printing_id", "as_of");

DROP TRIGGER IF EXISTS tcg_score_snapshot_immutable ON "tcg_score_snapshot";
CREATE TRIGGER tcg_score_snapshot_immutable
  BEFORE UPDATE OR DELETE ON "tcg_score_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_analytics_mutate();

DROP TRIGGER IF EXISTS tcg_score_snapshot_system_write ON "tcg_score_snapshot";
CREATE TRIGGER tcg_score_snapshot_system_write
  BEFORE INSERT ON "tcg_score_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_analytics_write();
