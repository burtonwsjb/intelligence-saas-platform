import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tcgPrinting } from "./tcg.js";

export const tcgMarketSource = pgTable("tcg_market_source", {
  sourceKey: text("source_key").primaryKey(),
  displayName: text("display_name").notNull(),
  supportsSold: boolean("supports_sold").notNull().default(false),
  supportsListings: boolean("supports_listings").notNull().default(false),
  supportsVolume: boolean("supports_volume").notNull().default(false),
  supportsCondition: boolean("supports_condition").notNull().default(true),
  supportsGrades: boolean("supports_grades").notNull().default(false),
  status: text("status").notNull().default("active"),
  defaultQuality: text("default_quality").notNull().default("normal"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tcgMarketIngest = pgTable(
  "tcg_market_ingest",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key")
      .notNull()
      .references(() => tcgMarketSource.sourceKey),
    sourceRecordId: text("source_record_id").notNull(),
    eventType: text("event_type").notNull(),
    fingerprint: text("fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    processingStatus: text("processing_status").notNull().default("received"),
    snapshotId: text("snapshot_id"),
    quarantineId: text("quarantine_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceRecordUidx: uniqueIndex("tcg_market_ingest_source_record_uidx").on(
      table.sourceKey,
      table.sourceRecordId,
    ),
  }),
);

export const tcgMarketSnapshot = pgTable(
  "tcg_market_snapshot",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => tcgPrinting.id),
    sourceKey: text("source_key")
      .notNull()
      .references(() => tcgMarketSource.sourceKey),
    marketType: text("market_type").notNull(),
    priceType: text("price_type").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    currency: text("currency").notNull(),
    condition: text("condition").notNull(),
    gradingCompany: text("grading_company"),
    gradeLabel: text("grade_label"),
    gradeNumeric: numeric("grade_numeric", { precision: 8, scale: 2, mode: "string" }),
    certificationNumber: text("certification_number"),
    price: numeric("price", { precision: 20, scale: 8, mode: "string" }),
    quantity: integer("quantity"),
    listingCount: integer("listing_count"),
    salesCount: integer("sales_count"),
    volumeValue: numeric("volume_value", { precision: 20, scale: 8, mode: "string" }),
    lowPrice: numeric("low_price", { precision: 20, scale: 8, mode: "string" }),
    highPrice: numeric("high_price", { precision: 20, scale: 8, mode: "string" }),
    medianPrice: numeric("median_price", { precision: 20, scale: 8, mode: "string" }),
    averagePrice: numeric("average_price", { precision: 20, scale: 8, mode: "string" }),
    bidCount: integer("bid_count"),
    sellerCount: integer("seller_count"),
    shippingAmount: numeric("shipping_amount", { precision: 20, scale: 8, mode: "string" }),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 8, mode: "string" }),
    feeAmount: numeric("fee_amount", { precision: 20, scale: 8, mode: "string" }),
    windowSeconds: integer("window_seconds"),
    aggregationKind: text("aggregation_kind").notNull().default("event"),
    sourceRecordId: text("source_record_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    sourceReference: text("source_reference"),
    qualityLabel: text("quality_label").notNull().default("normal"),
    outlierFlag: boolean("outlier_flag").notNull().default(false),
    outlierReason: text("outlier_reason"),
    outlierAlgorithmVersion: text("outlier_algorithm_version"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceRecordUidx: uniqueIndex("tcg_market_snapshot_source_record_uidx").on(
      table.sourceKey,
      table.sourceRecordId,
    ),
    printingTimeIdx: index("tcg_market_snapshot_printing_time_idx").on(
      table.printingId,
      table.observedAt,
    ),
    printingSourceTimeIdx: index("tcg_market_snapshot_printing_source_time_idx").on(
      table.printingId,
      table.sourceKey,
      table.observedAt,
    ),
    printingTypeTimeIdx: index("tcg_market_snapshot_printing_type_time_idx").on(
      table.printingId,
      table.marketType,
      table.observedAt,
    ),
  }),
);

export const tcgMarketQuarantine = pgTable(
  "tcg_market_quarantine",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key")
      .notNull()
      .references(() => tcgMarketSource.sourceKey),
    sourceRecordId: text("source_record_id").notNull(),
    reason: text("reason").notNull(),
    printingReference: jsonb("printing_reference")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fingerprintUidx: uniqueIndex("tcg_market_quarantine_fingerprint_uidx").on(
      table.sourceKey,
      table.sourceRecordId,
      table.fingerprint,
    ),
  }),
);

export const tcgMarketRevision = pgTable("tcg_market_revision", {
  id: text("id").primaryKey(),
  sourceKey: text("source_key").notNull(),
  sourceRecordId: text("source_record_id").notNull(),
  existingSnapshotId: text("existing_snapshot_id").notNull(),
  existingFingerprint: text("existing_fingerprint").notNull(),
  attemptedFingerprint: text("attempted_fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
