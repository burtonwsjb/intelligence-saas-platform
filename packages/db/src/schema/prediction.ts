import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tcgMarketFeatureSnapshot } from "./analytics.js";
import { tcgPrinting } from "./tcg.js";

export const tcgPrediction = pgTable(
  "tcg_prediction",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    dataCutoffAt: timestamp("data_cutoff_at", { withTimezone: true }).notNull(),
    horizon: text("horizon").notNull(),
    modelKey: text("model_key").notNull(),
    modelVersion: text("model_version").notNull(),
    featureSnapshotId: text("feature_snapshot_id").references(() => tcgMarketFeatureSnapshot.id),
    featureSetVersion: text("feature_set_version"),
    scoreVersion: text("score_version"),
    visibility: text("visibility").notNull().default("shadow"),
    status: text("status").notNull().default("issued"),
    languageCode: text("language_code").notNull(),
    priceAtIssue: numeric("price_at_issue", { precision: 20, scale: 8, mode: "string" }),
    expectedReturn: numeric("expected_return", { precision: 12, scale: 6, mode: "string" }),
    returnRangeLow: numeric("return_range_low", { precision: 12, scale: 6, mode: "string" }),
    returnRangeHigh: numeric("return_range_high", { precision: 12, scale: 6, mode: "string" }),
    priceRangeLow: numeric("price_range_low", { precision: 20, scale: 8, mode: "string" }),
    priceRangeHigh: numeric("price_range_high", { precision: 20, scale: 8, mode: "string" }),
    probabilityIncrease: numeric("probability_increase", { precision: 8, scale: 6, mode: "string" }),
    probabilityDecline: numeric("probability_decline", { precision: 8, scale: 6, mode: "string" }),
    confidence: numeric("confidence", { precision: 8, scale: 4, mode: "string" }),
    risk: numeric("risk", { precision: 8, scale: 4, mode: "string" }),
    dataQuality: text("data_quality").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    issueUidx: uniqueIndex("tcg_prediction_issue_uidx").on(
      table.printingId,
      table.issuedAt,
      table.horizon,
      table.modelVersion,
    ),
    printingIdx: index("tcg_prediction_printing_idx").on(table.printingId, table.issuedAt),
  }),
);

export const tcgPredictionOutcome = pgTable(
  "tcg_prediction_outcome",
  {
    id: text("id").primaryKey(),
    predictionId: text("prediction_id")
      .notNull()
      .references(() => tcgPrediction.id),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    actualPrice: numeric("actual_price", { precision: 20, scale: 8, mode: "string" }),
    actualReturn: numeric("actual_return", { precision: 12, scale: 6, mode: "string" }),
    directionalAccuracy: text("directional_accuracy"),
    forecastError: numeric("forecast_error", { precision: 12, scale: 6, mode: "string" }),
    absError: numeric("abs_error", { precision: 12, scale: 6, mode: "string" }),
    rangeHit: text("range_hit"),
    brierScore: numeric("brier_score", { precision: 12, scale: 6, mode: "string" }),
    benchmarkReturn: numeric("benchmark_return", { precision: 12, scale: 6, mode: "string" }),
    alpha: numeric("alpha", { precision: 12, scale: 6, mode: "string" }),
    drawdown: numeric("drawdown", { precision: 12, scale: 6, mode: "string" }),
    calibrationVersion: text("calibration_version").notNull(),
    dataQuality: text("data_quality").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    predictionUidx: uniqueIndex("tcg_prediction_outcome_prediction_uidx").on(table.predictionId),
  }),
);

export const tcgBacktestRun = pgTable("tcg_backtest_run", {
  id: text("id").primaryKey(),
  modelVersion: text("model_version").notNull(),
  methodVersion: text("method_version").notNull(),
  calibrationWindowEnd: timestamp("calibration_window_end", { withTimezone: true }),
  evaluationWindowStart: timestamp("evaluation_window_start", { withTimezone: true }).notNull(),
  evaluationWindowEnd: timestamp("evaluation_window_end", { withTimezone: true }).notNull(),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
