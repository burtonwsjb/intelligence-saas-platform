-- The latest score for each printing, kept ready so pages never re-derive it.
--
-- The overview and card list used to pick each printing's latest score with
-- DISTINCT ON over the whole tcg_score_snapshot history (156k rows, 393 MB on
-- staging, 2026-11-20). That sorted the full history on disk for every box on
-- the overview: 0.5s warm, 2.3s cold, four times per page load.
--
-- tcg_score_latest holds one row per printing: a copy of its newest snapshot
-- (newest as_of, then created_at, then id: the same order the explorer used).
-- An AFTER INSERT trigger on tcg_score_snapshot keeps it current, so every
-- writer (worker rescore, backfills) updates it with no code change. Snapshots
-- are immutable, so inserts are the only change to follow.
--
-- Global catalog data: no tenant rows, readable by app_user and app_worker,
-- written only through the trigger. Forward-only, idempotent.
CREATE TABLE IF NOT EXISTS "tcg_score_latest" (
  "printing_id" text PRIMARY KEY REFERENCES "tcg_printing"("id"),
  "id" text NOT NULL REFERENCES "tcg_score_snapshot"("id"),
  "as_of" timestamptz NOT NULL,
  "score_version" text NOT NULL,
  "opportunity_score" numeric(8, 4) NOT NULL,
  "risk_score" numeric(8, 4) NOT NULL,
  "confidence_score" numeric(8, 4) NOT NULL,
  "liquidity_score" numeric(8, 4) NOT NULL,
  "recommendation" text NOT NULL,
  "data_quality" text NOT NULL,
  "components" jsonb NOT NULL,
  "explanations" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "tcg_score_latest_recommendation_idx"
  ON "tcg_score_latest" ("recommendation", "opportunity_score" DESC);

CREATE OR REPLACE FUNCTION app.track_latest_score()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO tcg_score_latest AS l (
    printing_id, id, as_of, score_version, opportunity_score, risk_score, confidence_score,
    liquidity_score, recommendation, data_quality, components, explanations, created_at
  ) VALUES (
    NEW.printing_id, NEW.id, NEW.as_of, NEW.score_version, NEW.opportunity_score, NEW.risk_score,
    NEW.confidence_score, NEW.liquidity_score, NEW.recommendation, NEW.data_quality,
    NEW.components, NEW.explanations, NEW.created_at
  )
  ON CONFLICT (printing_id) DO UPDATE SET
    id = EXCLUDED.id, as_of = EXCLUDED.as_of, score_version = EXCLUDED.score_version,
    opportunity_score = EXCLUDED.opportunity_score, risk_score = EXCLUDED.risk_score,
    confidence_score = EXCLUDED.confidence_score, liquidity_score = EXCLUDED.liquidity_score,
    recommendation = EXCLUDED.recommendation, data_quality = EXCLUDED.data_quality,
    components = EXCLUDED.components, explanations = EXCLUDED.explanations,
    created_at = EXCLUDED.created_at
  WHERE (EXCLUDED.as_of, EXCLUDED.created_at, EXCLUDED.id) > (l.as_of, l.created_at, l.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tcg_score_snapshot_track_latest ON "tcg_score_snapshot";
CREATE TRIGGER tcg_score_snapshot_track_latest
  AFTER INSERT ON "tcg_score_snapshot"
  FOR EACH ROW EXECUTE FUNCTION app.track_latest_score();

-- Backfill from the existing history (one pass; later inserts go through the trigger).
INSERT INTO tcg_score_latest (
  printing_id, id, as_of, score_version, opportunity_score, risk_score, confidence_score,
  liquidity_score, recommendation, data_quality, components, explanations, created_at
)
SELECT DISTINCT ON (ss.printing_id)
  ss.printing_id, ss.id, ss.as_of, ss.score_version, ss.opportunity_score, ss.risk_score,
  ss.confidence_score, ss.liquidity_score, ss.recommendation, ss.data_quality,
  ss.components, ss.explanations, ss.created_at
FROM tcg_score_snapshot ss
ORDER BY ss.printing_id, ss.as_of DESC, ss.created_at DESC, ss.id DESC
ON CONFLICT (printing_id) DO NOTHING;

ANALYZE "tcg_score_latest";

DO $$
BEGIN
  GRANT SELECT ON TABLE "tcg_score_latest" TO app_user, app_worker;
  REVOKE INSERT, UPDATE, DELETE ON TABLE "tcg_score_latest" FROM app_user, app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
