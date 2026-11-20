-- Games whose card lists are built from tcgcsv.com (TCG Card Central has no
-- catalog for them). Owner request 2026-11-20: Marvel, Union Arena, My Little
-- Pony. Their sets, cards and printings are added by the worker's tcgcsv
-- matching step, only for the TCGplayer categories named in
-- TCGCSV_CATALOG_CATEGORY_IDS. Forward-only, idempotent.
INSERT INTO "tcg_game" ("game_key", "display_name", "publisher", "status")
VALUES
  ('marvel', 'Marvel', 'Marvel', 'active'),
  ('union_arena', 'Union Arena', 'Bandai', 'active'),
  ('my_little_pony', 'My Little Pony', 'Enterplay', 'active')
ON CONFLICT ("game_key") DO NOTHING;
