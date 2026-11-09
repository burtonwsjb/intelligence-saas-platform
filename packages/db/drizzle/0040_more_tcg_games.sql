-- Sentiment for every game TCG Card Central sells. Magic and Lorcana rows
-- already exist (0007); the other four are added so the TCC catalog import
-- can bring in their cards. Forward-only, idempotent.
INSERT INTO "tcg_game" ("game_key", "display_name", "publisher", "status")
VALUES
  ('magic', 'Magic: The Gathering', 'Wizards of the Coast', 'active'),
  ('lorcana', 'Disney Lorcana', 'Ravensburger', 'active'),
  ('flesh_and_blood', 'Flesh and Blood', 'Legend Story Studios', 'active'),
  ('star_wars_unlimited', 'Star Wars: Unlimited', 'Fantasy Flight Games', 'active'),
  ('digimon', 'Digimon Card Game', 'Bandai', 'active'),
  ('gundam', 'Gundam Card Game', 'Bandai', 'active')
ON CONFLICT ("game_key") DO NOTHING;
