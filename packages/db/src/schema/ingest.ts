import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { apiKey } from "./api-key.js";

export const SOURCE_EVENT_STATUSES = [
  "received",
  "queued",
  "processing",
  "processed",
  "failed",
] as const;

export type SourceEventStatus = (typeof SOURCE_EVENT_STATUSES)[number];

export const sourceEvent = pgTable(
  "source_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestId: text("request_id"),
    fingerprint: text("fingerprint").notNull(),
    entity: jsonb("entity").$type<Record<string, unknown>>().notNull().default({}),
    metrics: jsonb("metrics").$type<unknown[]>().notNull().default([]),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processingStatus: text("processing_status").notNull().default("received"),
    failureCategory: text("failure_category"),
    failureMessage: text("failure_message"),
    createdByApiKeyId: text("created_by_api_key_id").references(() => apiKey.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idempotencyUidx: uniqueIndex("source_event_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    organizationIdx: index("source_event_organization_id_idx").on(table.organizationId),
  }),
);

export const outboxJob = pgTable(
  "outbox_job",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => sourceEvent.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index("outbox_job_pending_idx").on(table.status, table.availableAt),
    organizationIdx: index("outbox_job_organization_id_idx").on(table.organizationId),
  }),
);
