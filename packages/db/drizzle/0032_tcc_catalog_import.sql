-- TCG Card Central catalog import. The worker adds the sets, cards and
-- printings of TCC's catalog feed so creator posts can resolve to real
-- printings. Catalog identity stays immutable: UPDATE and DELETE are still
-- refused by the existing triggers. app_worker gains INSERT only, and only
-- while acting as the system principal.
INSERT INTO "tcg_game" ("game_key", "display_name", "publisher", "status")
VALUES ('dragon_ball', 'Dragon Ball Super Card Game', 'Bandai', 'active')
ON CONFLICT ("game_key") DO NOTHING;

CREATE OR REPLACE FUNCTION app.require_system_tcg_catalog_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal text;
BEGIN
  principal := current_setting('app.current_principal_type', true);
  IF principal IS NOT NULL AND principal <> '' AND principal <> 'system' THEN
    RAISE EXCEPTION 'TCG catalog identity can only be written by the system principal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tcg_set_system_write ON "tcg_set";
CREATE TRIGGER tcg_set_system_write
  BEFORE INSERT ON "tcg_set"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_catalog_write();

DROP TRIGGER IF EXISTS tcg_card_system_write ON "tcg_card_concept";
CREATE TRIGGER tcg_card_system_write
  BEFORE INSERT ON "tcg_card_concept"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_catalog_write();

DROP TRIGGER IF EXISTS tcg_printing_system_write ON "tcg_printing";
CREATE TRIGGER tcg_printing_system_write
  BEFORE INSERT ON "tcg_printing"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_catalog_write();

DROP TRIGGER IF EXISTS tcg_printing_identifier_system_write ON "tcg_printing_identifier";
CREATE TRIGGER tcg_printing_identifier_system_write
  BEFORE INSERT ON "tcg_printing_identifier"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_catalog_write();

DROP TRIGGER IF EXISTS tcg_identifier_conflict_system_write ON "tcg_identifier_conflict";
CREATE TRIGGER tcg_identifier_conflict_system_write
  BEFORE INSERT ON "tcg_identifier_conflict"
  FOR EACH ROW EXECUTE FUNCTION app.require_system_tcg_catalog_write();

-- The resolver looks printings up by the part of the collector number before
-- the slash ("214" of "214/167"), so it never has to read the whole catalog.
CREATE INDEX IF NOT EXISTS tcg_printing_collector_left_idx
  ON "tcg_printing" (split_part("collector_number_normalized", '/', 1));

DO $$
BEGIN
  GRANT INSERT ON TABLE
    "tcg_set", "tcg_card_concept", "tcg_printing",
    "tcg_printing_identifier", "tcg_identifier_conflict"
  TO app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
