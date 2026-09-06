import { bigint, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { creator } from "./creator.js";
import { sourceAccount } from "./source.js";

export const DISCOVERY_PROVIDERS = ["youtube", "reddit"] as const;
export type DiscoveryProviderKey = (typeof DISCOVERY_PROVIDERS)[number];

export const DISCOVERY_RELEVANCE_STATES = ["candidate", "monitored", "excluded", "low_confidence"] as const;
export type DiscoveryRelevanceState = (typeof DISCOVERY_RELEVANCE_STATES)[number];

export const discoveryTopic = pgTable(
  "discovery_topic",
  {
    id: text("id").primaryKey(),
    providerKey: text("provider_key").notNull(),
    query: text("query").notNull(),
    strategyKey: text("strategy_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastErrorClass: text("last_error_class"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerQueryUidx: uniqueIndex("discovery_topic_provider_query_uidx").on(table.providerKey, table.query),
    enabledIdx: index("discovery_topic_enabled_idx").on(table.enabled, table.lastRunAt),
  }),
);

export const discoveryRun = pgTable("discovery_run", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").references(() => discoveryTopic.id),
  providerKey: text("provider_key").notNull(),
  query: text("query").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull().default("started"),
  videosSeen: integer("videos_seen").notNull().default(0),
  channelsSeen: integer("channels_seen").notNull().default(0),
  creatorsLinked: integer("creators_linked").notNull().default(0),
  contentIngested: integer("content_ingested").notNull().default(0),
  quotaUnits: integer("quota_units").notNull().default(0),
  errorClass: text("error_class"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const discoveredCreator = pgTable(
  "discovered_creator",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => creator.id),
    sourceAccountId: text("source_account_id")
      .notNull()
      .references(() => sourceAccount.id),
    providerKey: text("provider_key").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name"),
    firstTopicId: text("first_topic_id").references(() => discoveryTopic.id),
    lastTopicId: text("last_topic_id").references(() => discoveryTopic.id),
    topicHits: integer("topic_hits").notNull().default(1),
    relevanceScore: numeric("relevance_score", { precision: 8, scale: 4, mode: "string" }).notNull().default("0"),
    relevanceState: text("relevance_state").notNull().default("candidate"),
    reachViews: bigint("reach_views", { mode: "number" }),
    reachSubscribers: bigint("reach_subscribers", { mode: "number" }),
    discoveryProvenance: jsonb("discovery_provenance").$type<Record<string, unknown>>().notNull().default({}),
    lastMonitorAttemptAt: timestamp("last_monitor_attempt_at", { withTimezone: true }),
    lastMonitorSuccessAt: timestamp("last_monitor_success_at", { withTimezone: true }),
    nextMonitorAt: timestamp("next_monitor_at", { withTimezone: true }),
    monitorErrorClass: text("monitor_error_class"),
    firstDiscoveredAt: timestamp("first_discovered_at", { withTimezone: true }).defaultNow().notNull(),
    lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    externalUidx: uniqueIndex("discovered_creator_external_uidx").on(table.providerKey, table.externalAccountId),
    stateIdx: index("discovered_creator_state_idx").on(table.relevanceState, table.relevanceScore),
    creatorIdx: index("discovered_creator_creator_idx").on(table.creatorId),
  }),
);
