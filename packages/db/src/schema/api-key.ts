import { bigint, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";

export const apiKey = pgTable("api_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().unique(),
  secretHash: text("secret_hash").notNull(),
  scopes: text("scopes").notNull(),
  status: text("status").notNull().default("active"),
  environment: text("environment").notNull().default("test"),
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** Requests per rolling minute; null = only the shared per-IP guard (migration 0047). */
  rateLimitPerMinute: integer("rate_limit_per_minute"),
  /** Authenticated requests made with this key (migration 0047). */
  requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
  /** Operator's note: who the key is for, plan, contact (migration 0047). */
  note: text("note"),
  /** Issued by a platform operator from /admin/api-keys (migration 0047). */
  issuedByOperator: boolean("issued_by_operator").notNull().default(false),
});
