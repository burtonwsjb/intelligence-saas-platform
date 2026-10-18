-- Chart Sentiment. chart_pattern is the pattern database: the committed
-- catalog of chart-reading rules (moving averages, RSI, MACD, support and
-- resistance, double tops and bottoms, head and shoulders, Bollinger bands,
-- demand, supply and population) with each rule's explanation, prior and the
-- hit rate measured on our own card history. chart_sentiment holds the latest
-- score per printing and segment (raw, or one grade such as psa10), written by
-- the worker so reads are one primary-key lookup. Both are global derived
-- data: no tenant rows, readable by app_user, written only by app_worker.
CREATE TABLE IF NOT EXISTS "chart_pattern" (
  "key" text PRIMARY KEY,
  "name" text NOT NULL,
  "category" text NOT NULL,
  "direction" text NOT NULL,
  "horizon_days" integer NOT NULL,
  "min_points" integer NOT NULL,
  "requires" text,
  "base_weight" numeric(6, 3) NOT NULL,
  "prior_hit_rate" numeric(6, 4) NOT NULL,
  "rule" text NOT NULL,
  "explanation" text NOT NULL,
  "catalog_version" text NOT NULL,
  "samples" integer NOT NULL DEFAULT 0,
  "hits" integer NOT NULL DEFAULT 0,
  "flat" integer NOT NULL DEFAULT 0,
  "measured_hit_rate" numeric(6, 4),
  "measured_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chart_pattern_direction_chk CHECK ("direction" IN ('bullish', 'bearish')),
  CONSTRAINT chart_pattern_requires_chk CHECK ("requires" IS NULL OR "requires" IN ('sales', 'listings', 'population')),
  CONSTRAINT chart_pattern_counts_chk CHECK ("samples" >= 0 AND "hits" >= 0 AND "hits" <= "samples" AND "flat" >= 0)
);

CREATE TABLE IF NOT EXISTS "chart_sentiment" (
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "segment" text NOT NULL,
  "grading_company" text,
  "grade" text,
  "currency" text,
  "price_type" text,
  "score" integer,
  "label" text NOT NULL,
  "confidence" numeric(5, 3) NOT NULL,
  "points" integer NOT NULL,
  "data_from" date,
  "data_through" date,
  "last_price" numeric(20, 8),
  "signals" jsonb NOT NULL,
  "insufficient" jsonb NOT NULL,
  "inputs" jsonb NOT NULL,
  "backtest" jsonb NOT NULL,
  "method_version" text NOT NULL,
  "catalog_version" text NOT NULL,
  "computed_at" timestamptz NOT NULL,
  CONSTRAINT chart_sentiment_pkey PRIMARY KEY ("printing_id", "segment"),
  CONSTRAINT chart_sentiment_label_chk CHECK ("label" IN ('bullish', 'neutral', 'bearish', 'insufficient_history')),
  CONSTRAINT chart_sentiment_score_chk CHECK ("score" IS NULL OR ("score" BETWEEN -100 AND 100)),
  CONSTRAINT chart_sentiment_confidence_chk CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
CREATE INDEX IF NOT EXISTS chart_sentiment_computed_idx ON "chart_sentiment" ("computed_at");

DO $$
BEGIN
  GRANT SELECT ON TABLE "chart_pattern", "chart_sentiment" TO app_user, app_worker;
  GRANT INSERT, UPDATE ON TABLE "chart_pattern", "chart_sentiment" TO app_worker;
  GRANT DELETE ON TABLE "chart_sentiment" TO app_worker;
  REVOKE INSERT, UPDATE, DELETE ON TABLE "chart_pattern", "chart_sentiment" FROM app_user;
  REVOKE DELETE ON TABLE "chart_pattern" FROM app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
