import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";

export const notificationPreference = pgTable(
  "notification_preference",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    channel: text("channel").notNull(),
    optedIn: boolean("opted_in").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.organizationId, table.userId, table.category, table.channel],
    }),
  }),
);

export const emailDelivery = pgTable(
  "email_delivery",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(1),
    failureCategory: text("failure_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index("email_delivery_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const inAppNotification = pgTable(
  "in_app_notification",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    severity: text("severity").notNull().default("info"),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index("in_app_notification_org_idx").on(table.organizationId, table.userId, table.createdAt),
  }),
);

export const alertRule = pgTable(
  "alert_rule",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ruleType: text("rule_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    channelPreference: text("channel_preference").notNull().default("in_app"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("alert_rule_org_idx").on(table.organizationId, table.enabled),
  }),
);

export const usageWarning = pgTable(
  "usage_warning",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    meterKey: text("meter_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    thresholdPct: integer("threshold_pct").notNull(),
    notificationId: text("notification_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.organizationId, table.meterKey, table.periodStart, table.thresholdPct],
    }),
  }),
);
