import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { user } from "./auth.js";

export const crmOrganizationProfile = pgTable("crm_organization_profile", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  website: text("website"),
  industry: text("industry"),
  primaryUseCase: text("primary_use_case"),
  customerStatus: text("customer_status").notNull().default("signup"),
  lifecycleStage: text("lifecycle_stage").notNull().default("signup"),
  leadSource: text("lead_source"),
  signupSource: text("signup_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  activationRuleVersion: text("activation_rule_version"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const crmUserProfile = pgTable(
  "crm_user_profile",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    jobTitle: text("job_title"),
    timezone: text("timezone"),
    productRole: text("product_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.userId] }),
  }),
);

export const crmLifecycleTransition = pgTable(
  "crm_lifecycle_transition",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    fromStage: text("from_stage").notNull(),
    toStage: text("to_stage").notNull(),
    reason: text("reason").notNull(),
    actorType: text("actor_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("crm_lifecycle_transition_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const crmCustomerEvent = pgTable(
  "crm_customer_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("crm_customer_event_org_idx").on(table.organizationId, table.createdAt),
    idempotencyUidx: uniqueIndex("crm_customer_event_idempotency_uidx").on(
      table.organizationId,
      table.eventType,
      table.idempotencyKey,
    ),
  }),
);

export const crmOperatorNote = pgTable(
  "crm_operator_note",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("crm_operator_note_org_idx").on(table.organizationId, table.createdAt),
  }),
);

export const crmTag = pgTable("crm_tag", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const crmOrganizationTag = pgTable(
  "crm_organization_tag",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tagKey: text("tag_key")
      .notNull()
      .references(() => crmTag.key, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.tagKey] }),
  }),
);

export const crmSegmentDefinition = pgTable(
  "crm_segment_definition",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    version: text("version").notNull(),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    keyVersionUidx: uniqueIndex("crm_segment_definition_key_version_uidx").on(table.key, table.version),
  }),
);

export const crmSegmentMembership = pgTable(
  "crm_segment_membership",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    segmentId: text("segment_id")
      .notNull()
      .references(() => crmSegmentDefinition.id, { onDelete: "cascade" }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.segmentId] }),
  }),
);

export const crmChurnReason = pgTable(
  "crm_churn_reason",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    note: text("note"),
    capturedByUserId: text("captured_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("crm_churn_reason_org_idx").on(table.organizationId, table.capturedAt),
  }),
);
