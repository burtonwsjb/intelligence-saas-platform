import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tcgMarketFeatureSnapshot } from "./analytics.js";
import { tcgPrinting } from "./tcg.js";

export const tcgScoreSnapshot = pgTable(
  "tcg_score_snapshot",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    scoreVersion: text("score_version").notNull(),
    policyKey: text("policy_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    recommendationVersion: text("recommendation_version").notNull(),
    featureSnapshotId: text("feature_snapshot_id").references(() => tcgMarketFeatureSnapshot.id),
    opportunityScore: numeric("opportunity_score", { precision: 8, scale: 4, mode: "string" }).notNull(),
    riskScore: numeric("risk_score", { precision: 8, scale: 4, mode: "string" }).notNull(),
    confidenceScore: numeric("confidence_score", { precision: 8, scale: 4, mode: "string" }).notNull(),
    liquidityScore: numeric("liquidity_score", { precision: 8, scale: 4, mode: "string" }).notNull(),
    recommendation: text("recommendation").notNull(),
    uncalibrated: text("uncalibrated").notNull().default("true"),
    dataQuality: text("data_quality").notNull(),
    languageCode: text("language_code").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().notNull(),
    explanations: jsonb("explanations").$type<unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    versionUidx: uniqueIndex("tcg_score_snapshot_version_uidx").on(
      table.printingId,
      table.asOf,
      table.scoreVersion,
    ),
    printingAsOfIdx: index("tcg_score_snapshot_printing_asof_idx").on(table.printingId, table.asOf),
  }),
);
