import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { tcgMarketQuarantine } from "./tcg-market.js";
import { sourceMention } from "./source.js";

export const PROVIDER_KEYS = [
  "tcg_card_central",
  "tcgplayer",
  "ebay",
  "reddit",
  "youtube",
] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export const PROVIDER_TYPES = ["market", "social", "creator"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_MODES = ["disabled", "fixture", "live"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const PROVIDER_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "throttled",
  "auth_missing",
  "disabled_pending_credentials",
  "paused",
  "failed",
] as const;

export const providerRuntime = pgTable("provider_runtime", {
  providerKey: text("provider_key").primaryKey(),
  providerType: text("provider_type").notNull(),
  mode: text("mode").notNull().default("disabled"),
  enabled: boolean("enabled").notNull().default(false),
  paused: boolean("paused").notNull().default(false),
  credentialStatus: text("credential_status").notNull().default("missing"),
  healthStatus: text("health_status").notNull().default("unknown"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastErrorClass: text("last_error_class"),
  rateLimitRemaining: integer("rate_limit_remaining"),
  rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),
  retryAfterAt: timestamp("retry_after_at", { withTimezone: true }),
  cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
  lastSourceTimestamp: timestamp("last_source_timestamp", { withTimezone: true }),
  lastSourceId: text("last_source_id"),
  scheduleSeconds: integer("schedule_seconds").notNull().default(900),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  recordsIngested: integer("records_ingested").notNull().default(0),
  recordsQuarantined: integer("records_quarantined").notNull().default(0),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const providerSyncRun = pgTable(
  "provider_sync_run",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key")
      .notNull()
      .references(() => providerRuntime.providerKey),
    mode: text("mode").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("started"),
    limitCount: integer("limit_count"),
    receivedCount: integer("received_count").notNull().default(0),
    quarantinedCount: integer("quarantined_count").notNull().default(0),
    errorClass: text("error_class"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    providerTimeIdx: index("provider_sync_run_provider_time_idx").on(table.providerKey, table.startedAt),
  }),
);

export const platformOutbox = pgTable(
  "platform_outbox",
  {
    id: text("id").primaryKey(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index("platform_outbox_pending_idx").on(table.status, table.availableAt),
    typeIdx: index("platform_outbox_type_idx").on(table.jobType, table.status),
  }),
);

export const sourceSentiment = pgTable(
  "source_sentiment",
  {
    id: text("id").primaryKey(),
    mentionId: text("mention_id")
      .notNull()
      .references(() => sourceMention.id),
    analyzerVersion: text("analyzer_version").notNull(),
    direction: text("direction").notNull(),
    strength: text("strength").notNull(),
    confidence: text("confidence"),
    subject: text("subject").notNull(),
    entityKind: text("entity_kind").notNull(),
    timeHorizon: text("time_horizon").notNull(),
    marketRelevance: text("market_relevance").notNull(),
    excitement: text("excitement").notNull(),
    purchaseIntent: text("purchase_intent").notNull(),
    priceExpectation: text("price_expectation").notNull(),
    creatorRecommendation: text("creator_recommendation").notNull(),
    marketConcern: text("market_concern").notNull(),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    mentionVersionUidx: uniqueIndex("source_sentiment_mention_version_uidx").on(
      table.mentionId,
      table.analyzerVersion,
    ),
  }),
);

export const intelligenceQuarantine = pgTable(
  "intelligence_quarantine",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key").notNull(),
    recordType: text("record_type").notNull(),
    reason: text("reason").notNull(),
    payloadSummary: jsonb("payload_summary").$type<Record<string, unknown>>().notNull().default({}),
    fingerprint: text("fingerprint").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    resolutionState: text("resolution_state").notNull().default("open"),
    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fingerprintUidx: uniqueIndex("intelligence_quarantine_fingerprint_uidx").on(
      table.providerKey,
      table.recordType,
      table.fingerprint,
    ),
    openIdx: index("intelligence_quarantine_open_idx").on(table.resolutionState, table.receivedAt),
  }),
);

export const tcgMarketQuarantineReview = pgTable(
  "tcg_market_quarantine_review",
  {
    id: text("id").primaryKey(),
    quarantineId: text("quarantine_id")
      .notNull()
      .references(() => tcgMarketQuarantine.id),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    quarantineIdx: index("tcg_market_quarantine_review_qid_idx").on(table.quarantineId, table.createdAt),
  }),
);

export const workerHeartbeat = pgTable("worker_heartbeat", {
  workerKey: text("worker_key").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  queueDepth: integer("queue_depth"),
  failedJobs: integer("failed_jobs"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
