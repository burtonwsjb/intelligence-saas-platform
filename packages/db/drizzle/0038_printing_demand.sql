-- How often tcgcardcentral.com asks Sentiment about each card, one row per
-- printing per UTC day. A scan, a card page or a collection view on TCC each
-- count as a request. The hourly card rescore uses it to refresh cards people
-- just asked about first, then the most requested cards. Global catalog data:
-- no tenant rows and no user ids, readable and written by app_user (the API)
-- and app_worker. Forward-only.
CREATE TABLE IF NOT EXISTS "tcg_printing_demand" (
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "day" date NOT NULL,
  "requests" integer NOT NULL DEFAULT 0,
  "last_requested_at" timestamptz NOT NULL,
  PRIMARY KEY ("printing_id", "day"),
  CONSTRAINT tcg_printing_demand_requests_chk CHECK ("requests" >= 0)
);

CREATE INDEX IF NOT EXISTS "tcg_printing_demand_day_idx" ON "tcg_printing_demand" ("day");

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE ON TABLE "tcg_printing_demand" TO app_user, app_worker;
  REVOKE DELETE ON TABLE "tcg_printing_demand" FROM app_user, app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
