import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization.js";
import { sourceEvent } from "./ingest.js";

export const ENTITY_STATUSES = ["active", "archived"] as const;
export const QUALITY_FLAGS = ["complete", "partial", "stale", "conflicting", "suspect"] as const;
export const SIGNAL_DIRECTIONS = ["up", "down", "flat", "unknown"] as const;
export const DECISION_STATUSES = ["draft", "finalized"] as const;
export const EVIDENCE_TYPES = ["source_event", "observation", "external"] as const;

export const sourceDefinition = pgTable("source_definition", {
  sourceKey: text("source_key").primaryKey(),
  sourceType: text("source_type").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  defaultReliabilityWeight: numeric("default_reliability_weight", {
    precision: 5,
    scale: 4,
    mode: "string",
  })
    .notNull()
    .default("1"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const entity = pgTable(
  "entity",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    canonicalUidx: uniqueIndex("entity_org_canonical_uidx").on(
      table.organizationId,
      table.canonicalKey,
    ),
    orgIdUidx: uniqueIndex("entity_org_id_uidx").on(table.organizationId, table.id),
    typeIdx: index("entity_org_type_idx").on(table.organizationId, table.entityType),
  }),
);

export const entityIdentifier = pgTable(
  "entity_identifier",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    sourceNamespace: text("source_namespace").notNull(),
    identifierType: text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    lookupUidx: uniqueIndex("entity_identifier_lookup_uidx").on(
      table.organizationId,
      table.sourceNamespace,
      table.identifierType,
      table.normalizedValue,
    ),
    entityIdx: index("entity_identifier_entity_idx").on(table.organizationId, table.entityId),
  }),
);

export const observation = pgTable(
  "observation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: text("entity_id"),
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => sourceEvent.id),
    sourceNamespace: text("source_namespace").notNull(),
    observationType: text("observation_type").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "string" }),
    qualityFlag: text("quality_flag"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    supersedesObservationId: text("supersedes_observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdUidx: uniqueIndex("observation_org_id_uidx").on(table.organizationId, table.id),
    sourceEventUidx: uniqueIndex("observation_source_event_uidx").on(
      table.organizationId,
      table.sourceEventId,
    ),
    entityTimeIdx: index("observation_entity_time_idx").on(
      table.organizationId,
      table.entityId,
      table.observedAt,
    ),
    typeTimeIdx: index("observation_type_time_idx").on(
      table.organizationId,
      table.observationType,
      table.observedAt,
    ),
  }),
);

export const observationMetric = pgTable(
  "observation_metric",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    observationId: text("observation_id").notNull(),
    metricKey: text("metric_key").notNull(),
    numericValue: numeric("numeric_value", { precision: 20, scale: 8, mode: "string" }),
    textValue: text("text_value"),
    unit: text("unit"),
    dimension: jsonb("dimension").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    keyUidx: uniqueIndex("observation_metric_key_uidx").on(
      table.organizationId,
      table.observationId,
      table.metricKey,
    ),
    keyIdx: index("observation_metric_key_idx").on(table.organizationId, table.metricKey),
  }),
);

export const evidenceReference = pgTable(
  "evidence_reference",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    evidenceType: text("evidence_type").notNull(),
    sourceEventId: text("source_event_id"),
    observationId: text("observation_id"),
    externalReference: text("external_reference"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdUidx: uniqueIndex("evidence_reference_org_id_uidx").on(table.organizationId, table.id),
  }),
);

export const featureSnapshot = pgTable(
  "feature_snapshot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    featureSetKey: text("feature_set_key").notNull(),
    featureSetVersion: text("feature_set_version").notNull(),
    features: jsonb("features").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdUidx: uniqueIndex("feature_snapshot_org_id_uidx").on(table.organizationId, table.id),
    entityAsOfIdx: index("feature_snapshot_entity_as_of_idx").on(
      table.organizationId,
      table.entityId,
      table.asOf,
    ),
  }),
);

export const signal = pgTable(
  "signal",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    signalType: text("signal_type").notNull(),
    direction: text("direction").notNull().default("unknown"),
    magnitude: numeric("magnitude", { precision: 20, scale: 8, mode: "string" }),
    score: numeric("score", { precision: 20, scale: 8, mode: "string" }),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "string" }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    algorithmKey: text("algorithm_key").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    featureSnapshotId: text("feature_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdUidx: uniqueIndex("signal_org_id_uidx").on(table.organizationId, table.id),
    typeFromIdx: index("signal_type_from_idx").on(
      table.organizationId,
      table.signalType,
      table.validFrom,
    ),
    entityFromIdx: index("signal_entity_from_idx").on(
      table.organizationId,
      table.entityId,
      table.validFrom,
    ),
  }),
);

export const signalEvidence = pgTable(
  "signal_evidence",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    signalId: text("signal_id").notNull(),
    evidenceReferenceId: text("evidence_reference_id").notNull(),
    observationId: text("observation_id"),
    weight: numeric("weight", { precision: 5, scale: 4, mode: "string" }),
    role: text("role"),
  },
  (table) => ({
    linkUidx: uniqueIndex("signal_evidence_link_uidx").on(
      table.organizationId,
      table.signalId,
      table.evidenceReferenceId,
    ),
  }),
);

export const decisionRecord = pgTable(
  "decision_record",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    decisionType: text("decision_type").notNull(),
    status: text("status").notNull().default("draft"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    confidence: numeric("confidence", { precision: 5, scale: 4, mode: "string" }).notNull(),
    policyKey: text("policy_key").notNull(),
    policyVersion: text("policy_version").notNull(),
    featureSnapshotId: text("feature_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => ({
    orgIdUidx: uniqueIndex("decision_record_org_id_uidx").on(table.organizationId, table.id),
    entityIdx: index("decision_record_entity_idx").on(
      table.organizationId,
      table.entityId,
      table.createdAt,
    ),
  }),
);

export const decisionEvidence = pgTable("decision_evidence", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  decisionId: text("decision_id").notNull(),
  signalId: text("signal_id"),
  evidenceReferenceId: text("evidence_reference_id"),
  role: text("role"),
});
