import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";

/**
 * Application-owned tenant extension.
 * Identity (name, slug, memberships) lives on Better Auth `organization` / `member`.
 * Isolation metadata for future tenant-owned tables lives here.
 */
export const tenant = pgTable("tenant", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
