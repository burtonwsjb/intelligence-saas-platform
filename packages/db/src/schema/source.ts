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

export const sourcePlatform = pgTable("source_platform", {
  sourceType: text("source_type").primaryKey(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sourceAccount = pgTable(
  "source_account",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type")
      .notNull()
      .references(() => sourcePlatform.sourceType),
    externalAccountId: text("external_account_id").notNull(),
    handle: text("handle"),
    displayName: text("display_name"),
    canonicalUrl: text("canonical_url"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    externalUidx: uniqueIndex("source_account_external_uidx").on(table.sourceType, table.externalAccountId),
  }),
);

export const sourceIngest = pgTable(
  "source_ingest",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type")
      .notNull()
      .references(() => sourcePlatform.sourceType),
    sourceRecordId: text("source_record_id").notNull(),
    eventType: text("event_type").notNull(),
    fingerprint: text("fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    processingStatus: text("processing_status").notNull().default("received"),
    contentId: text("content_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    recordUidx: uniqueIndex("source_ingest_record_uidx").on(table.sourceType, table.sourceRecordId),
  }),
);

export const sourceContent = pgTable(
  "source_content",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type")
      .notNull()
      .references(() => sourcePlatform.sourceType),
    externalContentId: text("external_content_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => sourceAccount.id),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    title: text("title"),
    summary: text("summary"),
    canonicalUrl: text("canonical_url").notNull(),
    contentType: text("content_type").notNull(),
    language: text("language"),
    licenseStatus: text("license_status").notNull().default("reference_only"),
    retentionPolicy: text("retention_policy").notNull().default("bounded_excerpt"),
    transcriptAvailable: boolean("transcript_available").notNull().default(false),
    excerpt: text("excerpt"),
    excerptHash: text("excerpt_hash"),
    fingerprint: text("fingerprint").notNull(),
    dataQuality: text("data_quality").notNull().default("complete"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    externalUidx: uniqueIndex("source_content_external_uidx").on(table.sourceType, table.externalContentId),
    accountTimeIdx: index("source_content_account_time_idx").on(table.accountId, table.publishedAt),
    typeTimeIdx: index("source_content_type_time_idx").on(table.sourceType, table.publishedAt),
  }),
);

export const sourceContentSegment = pgTable(
  "source_content_segment",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => sourceContent.id),
    kind: text("kind").notNull(),
    startRef: text("start_ref"),
    endRef: text("end_ref"),
    excerpt: text("excerpt"),
    excerptHash: text("excerpt_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    contentIdx: index("source_segment_content_idx").on(table.contentId),
  }),
);

export const sourceMention = pgTable(
  "source_mention",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => sourceContent.id),
    segmentId: text("segment_id"),
    rawEntityText: text("raw_entity_text").notNull(),
    normalizedEntityText: text("normalized_entity_text").notNull(),
    mentionContext: text("mention_context").notNull().default("other"),
    candidateDirection: text("candidate_direction"),
    candidateTimeframe: text("candidate_timeframe"),
    candidatePrice: numeric("candidate_price", { precision: 20, scale: 8, mode: "string" }),
    candidatePercent: numeric("candidate_percent", { precision: 12, scale: 6, mode: "string" }),
    sentiment: text("sentiment").notNull().default("unknown"),
    sentimentConfidence: numeric("sentiment_confidence", { precision: 5, scale: 4, mode: "string" }),
    extractionVersion: text("extraction_version").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    contentIdx: index("source_mention_content_idx").on(table.contentId),
    textIdx: index("source_mention_text_idx").on(table.normalizedEntityText),
  }),
);

export const sourceEngagementSnapshot = pgTable(
  "source_engagement_snapshot",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => sourceContent.id),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    upvotes: integer("upvotes"),
    score: integer("score"),
    replyCount: integer("reply_count"),
    publishedAgeSeconds: integer("published_age_seconds"),
    sourceRecordId: text("source_record_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    recordUidx: uniqueIndex("source_engagement_record_uidx").on(table.contentId, table.sourceRecordId),
    timeIdx: index("source_engagement_time_idx").on(table.contentId, table.observedAt),
  }),
);
