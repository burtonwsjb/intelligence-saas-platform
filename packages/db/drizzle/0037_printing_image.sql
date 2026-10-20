-- Card pictures. tcg_printing is immutable, so each printing's picture lives
-- in its own row here: the https URL TCG Card Central's catalog feed sends for
-- the card, refreshed on each daily catalog pass. Global catalog data: no
-- tenant rows, readable by app_user, written only by app_worker. Forward-only.
CREATE TABLE IF NOT EXISTS "tcg_printing_image" (
  "printing_id" text PRIMARY KEY REFERENCES "tcg_printing"("id"),
  "image_url" text NOT NULL,
  "source_key" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_printing_image_url_chk CHECK ("image_url" ~ '^https://' AND length("image_url") <= 1000)
);

DO $$
BEGIN
  GRANT SELECT ON TABLE "tcg_printing_image" TO app_user, app_worker;
  GRANT INSERT, UPDATE ON TABLE "tcg_printing_image" TO app_worker;
  REVOKE INSERT, UPDATE, DELETE ON TABLE "tcg_printing_image" FROM app_user;
  REVOKE DELETE ON TABLE "tcg_printing_image" FROM app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
