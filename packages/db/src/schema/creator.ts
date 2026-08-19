import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sourceAccount, sourceContent, sourceContentSegment, sourceMention } from "./source.js";
import { tcgCardConcept, tcgPrinting } from "./tcg.js";
import { entityResolutionAttempt } from "./resolution.js";

export const creator = pgTable("creator", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  status: text("status").notNull().default("active"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const creatorSourceAccount = pgTable(
  "creator_source_account",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creator.id),
    sourceAccountId: text("source_account_id")
      .notNull()
      .references(() => sourceAccount.id),
    linkState: text("link_state").notNull().default("unresolved_ownership"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountUidx: uniqueIndex("creator_source_account_uidx").on(table.sourceAccountId),
    creatorIdx: index("creator_source_account_creator_idx").on(table.creatorId),
  }),
);

export const creatorCall = pgTable(
  "creator_call",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creator.id),
    sourceAccountId: text("source_account_id")
      .notNull()
      .references(() => sourceAccount.id),
    contentId: text("content_id")
      .notNull()
      .references(() => sourceContent.id),
    segmentId: text("segment_id").references(() => sourceContentSegment.id),
    mentionId: text("mention_id").references(() => sourceMention.id),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    printingId: text("printing_id").references(() => tcgPrinting.id),
    conceptId: text("concept_id").references(() => tcgCardConcept.id),
    resolutionAttemptId: text("resolution_attempt_id").references(() => entityResolutionAttempt.id),
    resolutionStatus: text("resolution_status").notNull(),
    resolutionConfidence: numeric("resolution_confidence", { precision: 5, scale: 4, mode: "string" }),
    priceAtCall: numeric("price_at_call", { precision: 20, scale: 8, mode: "string" }),
    priceCurrency: text("price_currency"),
    priceSource: text("price_source"),
    priceObservedAt: timestamp("price_observed_at", { withTimezone: true }),
    priceMethodVersion: text("price_method_version"),
    direction: text("direction").notNull(),
    targetPrice: numeric("target_price", { precision: 20, scale: 8, mode: "string" }),
    targetPercent: numeric("target_percent", { precision: 12, scale: 6, mode: "string" }),
    horizonCode: text("horizon_code").notNull().default("unspecified"),
    horizonCustomDays: numeric("horizon_custom_days", { precision: 10, scale: 2, mode: "string" }),
    statedConfidence: numeric("stated_confidence", { precision: 5, scale: 4, mode: "string" }),
    extractionConfidence: numeric("extraction_confidence", { precision: 5, scale: 4, mode: "string" }).notNull(),
    extractionVersion: text("extraction_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("finalized"),
    revisesCallId: text("revises_call_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fingerprintUidx: uniqueIndex("creator_call_fingerprint_uidx").on(table.fingerprint),
    creatorIdx: index("creator_call_creator_idx").on(table.creatorId, table.publishedAt),
    printingIdx: index("creator_call_printing_idx").on(table.printingId, table.publishedAt),
    directionIdx: index("creator_call_direction_idx").on(table.direction, table.publishedAt),
  }),
);

export const creatorCallOutcome = pgTable(
  "creator_call_outcome",
  {
    id: text("id").primaryKey(),
    callId: text("call_id")
      .notNull()
      .references(() => creatorCall.id),
    evaluationStatus: text("evaluation_status").notNull().default("pending"),
    startingPrice: numeric("starting_price", { precision: 20, scale: 8, mode: "string" }),
    endingPrice: numeric("ending_price", { precision: 20, scale: 8, mode: "string" }),
    returnPct: numeric("return_pct", { precision: 12, scale: 6, mode: "string" }),
    directionalCorrect: text("directional_correct"),
    targetHit: text("target_hit"),
    maxFavorableExcursion: numeric("max_favorable_excursion", { precision: 12, scale: 6, mode: "string" }),
    maxAdverseExcursion: numeric("max_adverse_excursion", { precision: 12, scale: 6, mode: "string" }),
    dataQuality: text("data_quality"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    methodVersion: text("method_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    callUidx: uniqueIndex("creator_call_outcome_call_uidx").on(table.callId),
  }),
);

export const creatorAuthoritySlice = pgTable(
  "creator_authority_slice",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creator.id),
    gameKey: text("game_key"),
    languageCode: text("language_code"),
    era: text("era").notNull().default("unspecified"),
    setKey: text("set_key"),
    priceTier: text("price_tier").notNull().default("unknown"),
    horizonCode: text("horizon_code"),
    rawGraded: text("raw_graded").notNull().default("raw"),
    sampleSize: numeric("sample_size", { precision: 12, scale: 0, mode: "string" }).notNull(),
    successes: numeric("successes", { precision: 12, scale: 0, mode: "string" }).notNull(),
    rawAccuracy: numeric("raw_accuracy", { precision: 8, scale: 6, mode: "string" }),
    recencyWeightedAccuracy: numeric("recency_weighted_accuracy", { precision: 8, scale: 6, mode: "string" }),
    wilsonLow: numeric("wilson_low", { precision: 8, scale: 6, mode: "string" }),
    wilsonCenter: numeric("wilson_center", { precision: 8, scale: 6, mode: "string" }),
    wilsonHigh: numeric("wilson_high", { precision: 8, scale: 6, mode: "string" }),
    bayesMean: numeric("bayes_mean", { precision: 8, scale: 6, mode: "string" }),
    avgReturn: numeric("avg_return", { precision: 12, scale: 6, mode: "string" }),
    medianReturn: numeric("median_return", { precision: 12, scale: 6, mode: "string" }),
    avgRelativeReturn: numeric("avg_relative_return", { precision: 12, scale: 6, mode: "string" }),
    avgMfe: numeric("avg_mfe", { precision: 12, scale: 6, mode: "string" }),
    avgMae: numeric("avg_mae", { precision: 12, scale: 6, mode: "string" }),
    earlyCallScore: numeric("early_call_score", { precision: 8, scale: 6, mode: "string" }),
    calibrationError: numeric("calibration_error", { precision: 8, scale: 6, mode: "string" }),
    authorityScore: numeric("authority_score", { precision: 8, scale: 4, mode: "string" }),
    authorityWeight: numeric("authority_weight", { precision: 8, scale: 6, mode: "string" }),
    trustState: text("trust_state").notNull(),
    formulaVersion: text("formula_version").notNull(),
    benchmarkRequirement: text("benchmark_requirement").notNull(),
    components: jsonb("components").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("creator_authority_slice_creator_idx").on(table.creatorId, table.createdAt),
  }),
);

export const creatorTrustEvent = pgTable(
  "creator_trust_event",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creator.id),
    trustState: text("trust_state").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    creatorIdx: index("creator_trust_event_creator_idx").on(table.creatorId, table.createdAt),
  }),
);
