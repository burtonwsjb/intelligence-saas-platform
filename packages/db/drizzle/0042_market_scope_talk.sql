-- Market talk about more than one card (sets, singles, graded, rarity groups,
-- sealed products) and cards singled out inside such talk ("especially the
-- Charizard", "except this Pikachu"), read clause by clause out of posts and
-- transcript windows. Card Market Sentiment counts the most specific
-- statement a post makes about each card; sealed product sentiment counts the
-- sealed statements. `clause` is a bounded quote (at most 280 characters).
-- Global catalog-side data: no tenant rows. Written only by the worker.
-- Forward-only, idempotent.
CREATE TABLE IF NOT EXISTS "market_scope_talk" (
  "id" text PRIMARY KEY,
  "content_id" text NOT NULL REFERENCES "source_content"("id"),
  "segment_id" text REFERENCES "source_content_segment"("id"),
  "set_id" text NOT NULL REFERENCES "tcg_set"("id"),
  "scope" text NOT NULL,
  "product_type" text,
  "grade" text,
  "rarity" text,
  "card_name" text,
  "sentiment" text NOT NULL,
  "clause" text NOT NULL,
  "horizon_days" integer,
  "horizon_phrase" text,
  "extraction_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_scope_talk_scope_chk CHECK ("scope" IN ('set', 'singles', 'graded', 'rarity', 'sealed', 'card')),
  CONSTRAINT market_scope_talk_sentiment_chk CHECK ("sentiment" IN ('positive', 'negative', 'neutral', 'excluded')),
  CONSTRAINT market_scope_talk_clause_chk CHECK (char_length("clause") <= 280),
  CONSTRAINT market_scope_talk_horizon_chk CHECK ("horizon_days" IS NULL OR "horizon_days" BETWEEN 1 AND 730)
);

CREATE INDEX IF NOT EXISTS "market_scope_talk_set_idx" ON "market_scope_talk" ("set_id", "scope");
CREATE INDEX IF NOT EXISTS "market_scope_talk_content_idx" ON "market_scope_talk" ("content_id");

DO $$
BEGIN
  GRANT SELECT ON TABLE "market_scope_talk" TO app_user, app_worker;
  GRANT INSERT, DELETE ON TABLE "market_scope_talk" TO app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
