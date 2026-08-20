import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";

/**
 * Server-checked platform operator grant. Not a tenant role.
 * Tenants may SELECT only their own row (if any).
 */
export const platformAdmins = pgTable("platform_admins", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  grantedByUserId: text("granted_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  note: text("note"),
});

/**
 * Append-only break-glass audit. Separate from tenant `audit_event`.
 */
export const platformBreakGlassAudit = pgTable(
  "platform_break_glass_audit",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdIdx: index("platform_break_glass_audit_created_idx").on(table.createdAt),
    orgIdx: index("platform_break_glass_audit_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const platformSupportCase = pgTable(
  "platform_support_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    body: text("body").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("platform_support_case_org_idx").on(table.organizationId, table.createdAt),
  }),
);
