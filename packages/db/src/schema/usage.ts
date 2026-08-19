import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { apiKey } from "./api-key.js";

export const usageEvent = pgTable(
  "usage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKey.id, {
      onDelete: "set null",
    }),
    meterKey: text("meter_key").notNull(),
    quantity: integer("quantity").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    idempotencyKey: text("idempotency_key"),
  },
  (table) => ({
    idempotencyUidx: uniqueIndex("usage_event_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
  }),
);

export const usageMonth = pgTable(
  "usage_month",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    meterKey: text("meter_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.organizationId, table.meterKey, table.periodStart],
    }),
  }),
);
