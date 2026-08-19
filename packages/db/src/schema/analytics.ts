import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { creatorCall } from "./creator.js";
import { tcgPrinting } from "./tcg.js";

export const tcgMarketFeatureSnapshot = pgTable(
  "tcg_market_feature_snapshot",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    featureSetKey: text("feature_set_key").notNull(),
    featureSetVersion: text("feature_set_version").notNull(),
    condition: text("condition").notNull().default("nm"),
    gradingCompany: text("grading_company"),
    gradeLabel: text("grade_label"),
    languageCode: text("language_code").notNull(),
    currency: text("currency").notNull(),
    outlierPolicy: text("outlier_policy").notNull(),
    features: jsonb("features").$type<Record<string, unknown>>().notNull(),
    dataQuality: text("data_quality").notNull(),
    sampleSize: integer("sample_size").notNull(),
    coverage: numeric("coverage", { precision: 8, scale: 6, mode: "string" }),
    stalenessHours: numeric("staleness_hours", { precision: 12, scale: 4, mode: "string" }),
    sourceComposition: jsonb("source_composition").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    snapshotUidx: uniqueIndex("tcg_market_feature_snapshot_uidx").on(
      table.printingId,
      table.asOf,
      table.featureSetKey,
      table.featureSetVersion,
      table.condition,
      table.outlierPolicy,
      table.gradingCompany,
      table.gradeLabel,
    ),
    printingAsOfIdx: index("tcg_market_feature_snapshot_printing_asof_idx").on(table.printingId, table.asOf),
  }),
);

export const tcgIndexDefinition = pgTable("tcg_index_definition", {
  indexKey: text("index_key").primaryKey(),
  name: text("name").notNull(),
  gameKey: text("game_key").notNull(),
  languageCode: text("language_code"),
  membershipRule: jsonb("membership_rule").$type<Record<string, unknown>>().notNull(),
  weightingMethod: text("weighting_method").notNull(),
  minLiquidity: integer("min_liquidity").notNull().default(1),
  minHistory: integer("min_history").notNull().default(1),
  rebalanceSchedule: text("rebalance_schedule").notNull().default("manual"),
  methodVersion: text("method_version").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tcgIndexMembership = pgTable(
  "tcg_index_membership",
  {
    id: text("id").primaryKey(),
    indexKey: text("index_key")
      .notNull()
      .references(() => tcgIndexDefinition.indexKey),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    weight: numeric("weight", { precision: 12, scale: 8, mode: "string" }).notNull(),
    methodVersion: text("method_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    openMemberUidx: uniqueIndex("tcg_index_membership_open_uidx").on(table.indexKey, table.printingId, table.effectiveFrom),
    asOfIdx: index("tcg_index_membership_asof_idx").on(table.indexKey, table.effectiveFrom, table.effectiveTo),
  }),
);

export const tcgIndexLevel = pgTable(
  "tcg_index_level",
  {
    id: text("id").primaryKey(),
    indexKey: text("index_key")
      .notNull()
      .references(() => tcgIndexDefinition.indexKey),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    indexValue: numeric("index_value", { precision: 20, scale: 8, mode: "string" }).notNull(),
    componentCount: integer("component_count").notNull(),
    pricedCount: integer("priced_count").notNull(),
    coverage: numeric("coverage", { precision: 8, scale: 6, mode: "string" }).notNull(),
    dataQuality: text("data_quality").notNull(),
    methodVersion: text("method_version").notNull(),
    weightingMethod: text("weighting_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pointUidx: uniqueIndex("tcg_index_level_point_uidx").on(table.indexKey, table.observedAt, table.methodVersion),
    timeIdx: index("tcg_index_level_time_idx").on(table.indexKey, table.observedAt),
  }),
);

export const creatorCallAlpha = pgTable(
  "creator_call_alpha",
  {
    id: text("id").primaryKey(),
    callId: text("call_id")
      .notNull()
      .references(() => creatorCall.id),
    methodVersion: text("method_version").notNull(),
    cardReturn: numeric("card_return", { precision: 12, scale: 6, mode: "string" }),
    benchmarkIndexKey: text("benchmark_index_key"),
    benchmarkReturn: numeric("benchmark_return", { precision: 12, scale: 6, mode: "string" }),
    relativeReturn: numeric("relative_return", { precision: 12, scale: 6, mode: "string" }),
    benchmarkLevelAtCall: numeric("benchmark_level_at_call", { precision: 20, scale: 8, mode: "string" }),
    benchmarkLevelAtHorizon: numeric("benchmark_level_at_horizon", { precision: 20, scale: 8, mode: "string" }),
    dataQuality: text("data_quality").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    callMethodUidx: uniqueIndex("creator_call_alpha_call_method_uidx").on(table.callId, table.methodVersion),
  }),
);
