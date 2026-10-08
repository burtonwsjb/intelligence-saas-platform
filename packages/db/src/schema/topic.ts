import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { organization } from "./organization.js";

/** Topics a workspace tracks (migration 0028). Indexes and RLS live in the SQL migration. */
export const tenantTopic = pgTable("tenant_topic", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  query: text("query").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
