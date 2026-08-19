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

export const TCG_KERNEL_ENTITY_TYPES = ["tcg_printing"] as const;

export const GENERIC_IDENTIFIER_TYPES = [
  "sku",
  "external_product_id",
  "listing_id",
  "account_id",
  "generic_id",
] as const;

export const EVENT_TYPE_TO_OBSERVATION: Record<GenericEventType, string> = {
  "metric.snapshot": "metric.snapshot",
  "pricing.snapshot": "metric.snapshot",
  "transaction.summary": "transaction.summary",
  "inventory.snapshot": "inventory.snapshot",
  "sentiment.snapshot": "sentiment.snapshot",
  "ranking.snapshot": "ranking.snapshot",
};

export const METRIC_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/;

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
  if ((TCG_KERNEL_ENTITY_TYPES as readonly string[]).includes(lowered)) {
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
