import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sourceContent, sourceContentSegment } from "./source.js";
import { tcgSet } from "./tcg.js";

/**
 * Market talk about more than one card (a set, its singles, graded cards, a
 * rarity group, sealed products) and cards singled out inside such talk, one
 * row per statement. See source/scope-talk.ts. Migration 0042.
 */
export const marketScopeTalk = pgTable(
  "market_scope_talk",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => sourceContent.id),
    segmentId: text("segment_id").references(() => sourceContentSegment.id),
    setId: text("set_id")
      .notNull()
      .references(() => tcgSet.id),
    scope: text("scope").notNull(),
    productType: text("product_type"),
    grade: text("grade"),
    rarity: text("rarity"),
    cardName: text("card_name"),
    sentiment: text("sentiment").notNull(),
    clause: text("clause").notNull(),
    horizonDays: integer("horizon_days"),
    horizonPhrase: text("horizon_phrase"),
    extractionVersion: text("extraction_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    setIdx: index("market_scope_talk_set_idx").on(table.setId, table.scope),
    contentIdx: index("market_scope_talk_content_idx").on(table.contentId),
  }),
);
