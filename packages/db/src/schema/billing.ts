import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";

export const plan = pgTable("plan", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
});

export const planEntitlement = pgTable(
  "plan_entitlement",
  {
    planKey: text("plan_key")
      .notNull()
      .references(() => plan.key, { onDelete: "cascade" }),
    entitlementKey: text("entitlement_key").notNull(),
    valueKind: text("value_kind").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    limitValue: integer("limit_value"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.planKey, table.entitlementKey] }),
  }),
);

export const tenantBilling = pgTable(
  "tenant_billing",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    planKey: text("plan_key")
      .notNull()
      .references(() => plan.key)
      .default("free"),
    status: text("status").notNull().default("none"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    stripeCustomerUidx: uniqueIndex("tenant_billing_stripe_customer_uidx").on(
      table.stripeCustomerId,
    ),
  }),
);

export const tenantEntitlementOverride = pgTable(
  "tenant_entitlement_override",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entitlementKey: text("entitlement_key").notNull(),
    valueKind: text("value_kind").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    limitValue: integer("limit_value"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.organizationId, table.entitlementKey],
    }),
  }),
);

export const stripeEvent = pgTable("stripe_event", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  organizationId: text("organization_id").references(() => organization.id, {
    onDelete: "set null",
  }),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
