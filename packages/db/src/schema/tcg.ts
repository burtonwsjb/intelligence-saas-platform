import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const tcgGame = pgTable("tcg_game", {
  gameKey: text("game_key").primaryKey(),
  displayName: text("display_name").notNull(),
  publisher: text("publisher"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tcgLanguage = pgTable("tcg_language", {
  languageCode: text("language_code").primaryKey(),
  displayName: text("display_name").notNull(),
  required: boolean("required").notNull().default(false),
  status: text("status").notNull().default("active"),
});

export const tcgSet = pgTable(
  "tcg_set",
  {
    id: text("id").primaryKey(),
    gameKey: text("game_key")
      .notNull()
      .references(() => tcgGame.gameKey),
    canonicalSetKey: text("canonical_set_key").notNull(),
    name: text("name").notNull(),
    languageScope: text("language_scope"),
    releaseDate: date("release_date"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    gameKeyUidx: uniqueIndex("tcg_set_game_key_uidx").on(table.gameKey, table.canonicalSetKey),
  }),
);

export const tcgCardConcept = pgTable(
  "tcg_card_concept",
  {
    id: text("id").primaryKey(),
    gameKey: text("game_key")
      .notNull()
      .references(() => tcgGame.gameKey),
    conceptKey: text("concept_key").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    gameKeyUidx: uniqueIndex("tcg_card_game_key_uidx").on(table.gameKey, table.conceptKey),
  }),
);

export const tcgPrinting = pgTable(
  "tcg_printing",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => tcgCardConcept.id),
    setId: text("set_id")
      .notNull()
      .references(() => tcgSet.id),
    gameKey: text("game_key")
      .notNull()
      .references(() => tcgGame.gameKey),
    collectorNumber: text("collector_number").notNull(),
    collectorNumberNormalized: text("collector_number_normalized").notNull(),
    languageCode: text("language_code")
      .notNull()
      .references(() => tcgLanguage.languageCode),
    variantKey: text("variant_key").notNull(),
    rarity: text("rarity"),
    finish: text("finish"),
    edition: text("edition"),
    promo: boolean("promo").notNull().default(false),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    canonicalPrintingKey: text("canonical_printing_key").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    canonicalUidx: uniqueIndex("tcg_printing_canonical_uidx").on(table.canonicalPrintingKey),
    identityUidx: uniqueIndex("tcg_printing_identity_uidx").on(
      table.setId,
      table.collectorNumberNormalized,
      table.languageCode,
      table.variantKey,
    ),
    lookupIdx: index("tcg_printing_lookup_idx").on(
      table.gameKey,
      table.setId,
      table.collectorNumberNormalized,
      table.languageCode,
      table.variantKey,
    ),
  }),
);

export const tcgPrintingIdentifier = pgTable(
  "tcg_printing_identifier",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    sourceNamespace: text("source_namespace").notNull(),
    identifierType: text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    lookupUidx: uniqueIndex("tcg_printing_identifier_uidx").on(
      table.sourceNamespace,
      table.identifierType,
      table.normalizedValue,
    ),
  }),
);

export const tcgIdentifierConflict = pgTable("tcg_identifier_conflict", {
  id: text("id").primaryKey(),
  sourceNamespace: text("source_namespace").notNull(),
  identifierType: text("identifier_type").notNull(),
  normalizedValue: text("normalized_value").notNull(),
  existingPrintingId: text("existing_printing_id").notNull(),
  attemptedPrintingId: text("attempted_printing_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tcgCardNameAlias = pgTable(
  "tcg_card_name_alias",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => tcgCardConcept.id),
    languageCode: text("language_code")
      .notNull()
      .references(() => tcgLanguage.languageCode),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    aliasUidx: uniqueIndex("tcg_card_name_alias_uidx").on(
      table.cardId,
      table.languageCode,
      table.normalizedName,
    ),
    nameIdx: index("tcg_card_name_alias_name_idx").on(table.normalizedName),
  }),
);
