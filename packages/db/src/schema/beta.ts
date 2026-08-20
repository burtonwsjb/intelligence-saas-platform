import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";
import { platformSupportCase } from "./platform.js";

export const platformFeatureFlags = pgTable("platform_feature_flags", {
  flagKey: text("flag_key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
});

export const betaInvitation = pgTable(
  "beta_invitation",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email"),
    organizationHint: text("organization_hint"),
    cohort: text("cohort").notNull().default("beta_wave_1"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    expiresIdx: index("beta_invitation_expires_idx").on(table.expiresAt),
  }),
);

export const betaOrganization = pgTable("beta_organization", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  cohort: text("cohort").notNull().default("internal"),
  useCase: text("use_case"),
  onboarding: jsonb("onboarding").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const productFeedback = pgTable(
  "product_feedback",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    pageContext: text("page_context"),
    severity: text("severity").notNull().default("normal"),
    message: text("message").notNull(),
    status: text("status").notNull().default("open"),
    supportCaseId: text("support_case_id").references(() => platformSupportCase.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("product_feedback_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const bugReport = pgTable(
  "bug_report",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    requestId: text("request_id"),
    route: text("route"),
    browser: text("browser"),
    description: text("description").notNull(),
    reproduction: text("reproduction"),
    status: text("status").notNull().default("open"),
    supportCaseId: text("support_case_id").references(() => platformSupportCase.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("bug_report_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const productEvent = pgTable(
  "product_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    eventName: text("event_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("product_event_org_idx").on(table.organizationId, table.createdAt),
  }),
);
