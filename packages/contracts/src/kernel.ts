export const GENERIC_EVENT_TYPES = [
  "metric.snapshot",
  "pricing.snapshot",
  "transaction.summary",
  "inventory.snapshot",
  "sentiment.snapshot",
  "ranking.snapshot",
] as const;

export type GenericEventType = (typeof GENERIC_EVENT_TYPES)[number];

export const GENERIC_ENTITY_TYPES = [
  "sku",
  "product",
  "listing",
  "account",
  "item",
  "generic",
] as const;

export const GENERIC_IDENTIFIER_TYPES = [
  "sku",
  "external_product_id",
  "listing_id",
  "account_id",
  "generic_id",
] as const;

export const QUALITY_FLAGS = [
  "complete",
  "partial",
  "stale",
  "conflicting",
  "suspect",
] as const;

export const SIGNAL_DIRECTIONS = ["up", "down", "flat", "unknown"] as const;

export const EVENT_TYPE_TO_OBSERVATION: Record<GenericEventType, string> = {
  "metric.snapshot": "metric.snapshot",
  "pricing.snapshot": "metric.snapshot",
  "transaction.summary": "transaction.summary",
  "inventory.snapshot": "inventory.snapshot",
  "sentiment.snapshot": "sentiment.snapshot",
  "ranking.snapshot": "ranking.snapshot",
};

export const METRIC_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/;

export type EntityContract = {
  id: string;
  organization_id: string;
  entity_type: string;
  canonical_key: string;
  display_name?: string | null;
  status: "active" | "archived";
  attributes: Record<string, unknown>;
};

export type ObservationContract = {
  id: string;
  organization_id: string;
  entity_id: string | null;
  source_event_id: string;
  observation_type: string;
  observed_at: string;
  received_at: string;
  confidence?: number | null;
  quality_flag?: (typeof QUALITY_FLAGS)[number] | null;
};

export type MetricContract = {
  observation_id: string;
  metric_key: string;
  numeric_value: string | null;
  text_value: string | null;
  unit?: string | null;
};

export type SignalContract = {
  id: string;
  organization_id: string;
  entity_id: string;
  signal_type: string;
  direction: (typeof SIGNAL_DIRECTIONS)[number];
  confidence: number;
  algorithm_key: string;
  algorithm_version: string;
  valid_from: string;
};

export type FeatureSnapshotContract = {
  id: string;
  organization_id: string;
  entity_id: string;
  feature_set_key: string;
  feature_set_version: string;
  features: Record<string, unknown>;
  fingerprint: string;
  as_of: string;
};

export type DecisionRecordContract = {
  id: string;
  organization_id: string;
  entity_id: string;
  decision_type: string;
  status: "draft" | "finalized";
  result: Record<string, unknown>;
  confidence: number;
  policy_key: string;
  policy_version: string;
  feature_snapshot_id?: string | null;
};

export type GenericSourceEventBody = {
  event_type: GenericEventType;
  occurred_at: string;
  idempotency_key: string;
  entity: {
    type: string;
    external_id: string;
    display_name?: string;
    attributes?: Record<string, unknown>;
  };
  metrics: { key: string; value: number; unit?: string }[];
  payload: Record<string, unknown>;
};

export function isGenericEventType(value: string): value is GenericEventType {
  return (GENERIC_EVENT_TYPES as readonly string[]).includes(value);
}

export function isValidMetricKey(value: string): boolean {
  return typeof value === "string" && value.length <= 64 && METRIC_KEY_PATTERN.test(value);
}

export function normalizeIdentifierValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseEntityType(value: string): string {
  const lowered = value.trim().toLowerCase();
  if ((GENERIC_ENTITY_TYPES as readonly string[]).includes(lowered)) {
    return lowered;
  }
  return "generic";
}

export function parseIdentifierType(entityType: string): string {
  if ((GENERIC_IDENTIFIER_TYPES as readonly string[]).includes(entityType)) {
    return entityType;
  }
  return "generic_id";
}

export function canonicalEntityKey(input: {
  entityType: string;
  sourceNamespace: string;
  identifierType: string;
  normalizedValue: string;
}): string {
  return `${input.entityType}:${input.sourceNamespace}:${input.identifierType}:${input.normalizedValue}`;
}

export function numericToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Metric value must be finite.");
  }
  return value.toString();
}

export function parseConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Confidence must be between 0 and 1.");
  }
  return value;
}

export function parseGenericSourceEventBody(input: {
  event_type: string;
  occurred_at: string;
  idempotency_key: string;
  entity: { type: string; external_id: string; display_name?: string; attributes?: Record<string, unknown> };
  metrics?: { key: string; value: number; unit?: string }[];
  payload?: Record<string, unknown>;
}): GenericSourceEventBody {
  if (!isGenericEventType(input.event_type)) {
    throw new Error("Unknown event type.");
  }
  for (const metric of input.metrics ?? []) {
    if (!isValidMetricKey(metric.key)) {
      throw new Error("Invalid metric key.");
    }
  }
  return {
    event_type: input.event_type,
    occurred_at: input.occurred_at,
    idempotency_key: input.idempotency_key,
    entity: input.entity,
    metrics: input.metrics ?? [],
    payload: input.payload ?? {},
  };
}
