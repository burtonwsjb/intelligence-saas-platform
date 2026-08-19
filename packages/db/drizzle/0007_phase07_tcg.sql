-- Phase 07: TCG canonical identity (platform-global reference data).
-- Not tenant-owned. No market history. No TCG Card Central network calls.

CREATE TABLE IF NOT EXISTS "tcg_game" (
  "game_key" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "publisher" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_game_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_game_key_chk CHECK ("game_key" ~ '^[a-z][a-z0-9_]*$')
);

CREATE TABLE IF NOT EXISTS "tcg_language" (
  "language_code" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "required" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  CONSTRAINT tcg_language_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_language_code_chk CHECK ("language_code" ~ '^[a-z]{2}(-[A-Z][a-z]+)?$')
);

CREATE TABLE IF NOT EXISTS "tcg_set" (
  "id" text PRIMARY KEY,
  "game_key" text NOT NULL REFERENCES "tcg_game"("game_key"),
  "canonical_set_key" text NOT NULL,
  "name" text NOT NULL,
  "language_scope" text,
  "release_date" date,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_set_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_set_key_chk CHECK ("canonical_set_key" ~ '^[a-z0-9][a-z0-9_-]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_set_game_key_uidx
  ON "tcg_set" ("game_key", "canonical_set_key");

CREATE TABLE IF NOT EXISTS "tcg_card_concept" (
  "id" text PRIMARY KEY,
  "game_key" text NOT NULL REFERENCES "tcg_game"("game_key"),
  "concept_key" text NOT NULL,
  "canonical_name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_card_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_card_key_chk CHECK ("concept_key" ~ '^[a-z0-9][a-z0-9_-]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_card_game_key_uidx
  ON "tcg_card_concept" ("game_key", "concept_key");

CREATE TABLE IF NOT EXISTS "tcg_printing" (
  "id" text PRIMARY KEY,
  "card_id" text NOT NULL REFERENCES "tcg_card_concept"("id"),
  "set_id" text NOT NULL REFERENCES "tcg_set"("id"),
  "game_key" text NOT NULL REFERENCES "tcg_game"("game_key"),
  "collector_number" text NOT NULL,
  "collector_number_normalized" text NOT NULL,
  "language_code" text NOT NULL REFERENCES "tcg_language"("language_code"),
  "variant_key" text NOT NULL,
  "rarity" text,
  "finish" text,
  "edition" text,
  "promo" boolean NOT NULL DEFAULT false,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "canonical_printing_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcg_printing_status_chk CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT tcg_printing_variant_chk CHECK ("variant_key" ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT tcg_printing_collector_chk CHECK (char_length("collector_number") >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_printing_canonical_uidx
  ON "tcg_printing" ("canonical_printing_key");
CREATE UNIQUE INDEX IF NOT EXISTS tcg_printing_identity_uidx
  ON "tcg_printing" ("set_id", "collector_number_normalized", "language_code", "variant_key");
CREATE INDEX IF NOT EXISTS tcg_printing_lookup_idx
  ON "tcg_printing" ("game_key", "set_id", "collector_number_normalized", "language_code", "variant_key");
CREATE INDEX IF NOT EXISTS tcg_printing_card_idx
  ON "tcg_printing" ("card_id");

CREATE TABLE IF NOT EXISTS "tcg_printing_identifier" (
  "id" text PRIMARY KEY,
  "printing_id" text NOT NULL REFERENCES "tcg_printing"("id"),
  "source_namespace" text NOT NULL,
  "identifier_type" text NOT NULL,
  "identifier_value" text NOT NULL,
  "normalized_value" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tcg_printing_identifier_uidx
  ON "tcg_printing_identifier" ("source_namespace", "identifier_type", "normalized_value");
CREATE INDEX IF NOT EXISTS tcg_printing_identifier_printing_idx
  ON "tcg_printing_identifier" ("printing_id");

CREATE TABLE IF NOT EXISTS "tcg_identifier_conflict" (
  "id" text PRIMARY KEY,
  "source_namespace" text NOT NULL,
  "identifier_type" text NOT NULL,
  "normalized_value" text NOT NULL,
  "existing_printing_id" text NOT NULL,
  "attempted_printing_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "tcg_game" ("game_key", "display_name", "publisher", "status")
VALUES
  ('pokemon', 'Pokémon', 'The Pokémon Company', 'active'),
  ('one_piece', 'One Piece Card Game', 'Bandai', 'active'),
  ('magic', 'Magic: The Gathering', 'Wizards of the Coast', 'active'),
  ('lorcana', 'Disney Lorcana', 'Ravensburger', 'active'),
  ('yugioh', 'Yu-Gi-Oh!', 'Konami', 'active'),
  ('other', 'Other TCG', NULL, 'active')
ON CONFLICT ("game_key") DO NOTHING;

INSERT INTO "tcg_language" ("language_code", "display_name", "required", "status")
VALUES
  ('en', 'English', true, 'active'),
  ('ja', 'Japanese', true, 'active'),
  ('zh-Hans', 'Simplified Chinese', true, 'active'),
  ('zh-Hant', 'Traditional Chinese', false, 'active'),
  ('ko', 'Korean', false, 'active'),
  ('de', 'German', false, 'active'),
  ('fr', 'French', false, 'active'),
  ('es', 'Spanish', false, 'active'),
  ('it', 'Italian', false, 'active'),
  ('pt', 'Portuguese', false, 'active')
ON CONFLICT ("language_code") DO NOTHING;

CREATE OR REPLACE FUNCTION app.forbid_tcg_canonical_mutate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'TCG canonical identity is immutable.';
END;
$$;

DROP TRIGGER IF EXISTS tcg_game_immutable ON "tcg_game";
CREATE TRIGGER tcg_game_immutable
  BEFORE UPDATE OR DELETE ON "tcg_game"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_language_immutable ON "tcg_language";
CREATE TRIGGER tcg_language_immutable
  BEFORE UPDATE OR DELETE ON "tcg_language"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_set_immutable ON "tcg_set";
CREATE TRIGGER tcg_set_immutable
  BEFORE UPDATE OR DELETE ON "tcg_set"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_card_immutable ON "tcg_card_concept";
CREATE TRIGGER tcg_card_immutable
  BEFORE UPDATE OR DELETE ON "tcg_card_concept"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_printing_immutable ON "tcg_printing";
CREATE TRIGGER tcg_printing_immutable
  BEFORE UPDATE OR DELETE ON "tcg_printing"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_printing_identifier_immutable ON "tcg_printing_identifier";
CREATE TRIGGER tcg_printing_identifier_immutable
  BEFORE UPDATE OR DELETE ON "tcg_printing_identifier"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();

DROP TRIGGER IF EXISTS tcg_identifier_conflict_immutable ON "tcg_identifier_conflict";
CREATE TRIGGER tcg_identifier_conflict_immutable
  BEFORE UPDATE OR DELETE ON "tcg_identifier_conflict"
  FOR EACH ROW EXECUTE FUNCTION app.forbid_tcg_canonical_mutate();
