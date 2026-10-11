import { date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { tcgPrinting } from "./tcg.js";

/**
 * The chart pattern database: one row per pattern of the committed catalog
 * (packages/db/src/analytics/chart/patterns.ts) with its rule, plain-English
 * explanation, direction and prior, plus the hit rate measured on our own card
 * history (summed from every stored segment's backtest).
 */
export const chartPattern = pgTable("chart_pattern", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  direction: text("direction").notNull(),
  horizonDays: integer("horizon_days").notNull(),
  minPoints: integer("min_points").notNull(),
  requires: text("requires"),
  baseWeight: numeric("base_weight", { precision: 6, scale: 3, mode: "string" }).notNull(),
  priorHitRate: numeric("prior_hit_rate", { precision: 6, scale: 4, mode: "string" }).notNull(),
  rule: text("rule").notNull(),
  explanation: text("explanation").notNull(),
  catalogVersion: text("catalog_version").notNull(),
  samples: integer("samples").notNull().default(0),
  hits: integer("hits").notNull().default(0),
  flat: integer("flat").notNull().default(0),
  measuredHitRate: numeric("measured_hit_rate", { precision: 6, scale: 4, mode: "string" }),
  measuredAt: timestamp("measured_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Chart Sentiment per printing and segment ("raw", or a grade such as
 * "psa10"), recomputed by the worker. Reads are one primary-key lookup.
 */
export const chartSentiment = pgTable(
  "chart_sentiment",
  {
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    segment: text("segment").notNull(),
    gradingCompany: text("grading_company"),
    grade: text("grade"),
    currency: text("currency"),
    priceType: text("price_type"),
    score: integer("score"),
    label: text("label").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 3, mode: "string" }).notNull(),
    points: integer("points").notNull(),
    dataFrom: date("data_from", { mode: "string" }),
    dataThrough: date("data_through", { mode: "string" }),
    lastPrice: numeric("last_price", { precision: 20, scale: 8, mode: "string" }),
    signals: jsonb("signals").$type<unknown[]>().notNull(),
    insufficient: jsonb("insufficient").$type<unknown[]>().notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    backtest: jsonb("backtest").$type<Record<string, { samples: number; hits: number; flat: number }>>().notNull(),
    methodVersion: text("method_version").notNull(),
    catalogVersion: text("catalog_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "chart_sentiment_pkey", columns: [table.printingId, table.segment] }),
    computedIdx: index("chart_sentiment_computed_idx").on(table.computedAt),
  }),
);
