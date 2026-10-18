import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { organization } from "./organization.js";
import { creator } from "./creator.js";

export const TENANT_CREATOR_PLATFORMS = ["youtube", "reddit"] as const;
export const TENANT_CREATOR_PREFERENCES = ["follow", "hide"] as const;
export const TENANT_CREATOR_STATUSES = ["pending", "resolved", "not_found", "blocked", "failed"] as const;

/**
 * A workspace's private influencer list (migration 0027). Indexes, checks and
 * RLS policies live in the SQL migration.
 */
export const tenantCreatorList = pgTable(
  "tenant_creator_list",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    inputHandle: text("input_handle"),
    externalAccountId: text("external_account_id"),
    creatorId: text("creator_id").references(() => creator.id),
    preference: text("preference").notNull().default("follow"),
    status: text("status").notNull().default("pending"),
    errorClass: text("error_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);
