import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization.js";

/**
 * Canonical tenant-owned table used as the Phase 03 isolation fixture
 * and the documented pattern for later tenant-owned application tables.
 */
export const tenantResource = pgTable("tenant_resource", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
