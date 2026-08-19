import { createHash } from "node:crypto";
import {
  EVENT_TYPE_TO_OBSERVATION,
  canonicalEntityKey,
  isGenericEventType,
  isValidMetricKey,
  normalizeIdentifierValue,
  numericToDecimalString,
  parseEntityType,
  parseIdentifierType,
} from "./kernel-registry.js";
import {
  InvalidConfidenceError,
  InvalidMetricError,
  KernelValidationError,
  MissingSignalEvidenceError,
  UnknownEventTypeError,
} from "./kernel-errors.js";
import { findEntityIdentifier, getEntity, insertEntity, insertEntityIdentifier } from "./repos/entity.js";
import { getObservationBySourceEvent, insertObservation, insertObservationMetric } from "./repos/observation.js";
import { insertEvidenceReference } from "./repos/evidence.js";
import { insertFeatureSnapshot, insertSignal, insertSignalEvidence } from "./repos/signal.js";
import type { Database } from "./client.js";

export function requireSignalEvidence(count: number): void {
  if (count < 1) {
    throw new MissingSignalEvidenceError();
  }
}

const SOURCE_NAMESPACE = "ingest";
const ALGORITHM_KEY = "kernel.normalize";
const ALGORITHM_VERSION = "1";
const FEATURE_SET_KEY = "ingest.v1";
const FEATURE_SET_VERSION = "1";

type SourceEventRow = {
  id: string;
  organizationId: string;
  eventType: string;
  occurredAt: Date;
  receivedAt: Date;
  entity: Record<string, unknown>;
  metrics: unknown;
  payload: Record<string, unknown>;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function fingerprintFeatures(features: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableValue(features))).digest("hex");
}

function deterministicId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

function readEntity(raw: Record<string, unknown>) {
  const type = typeof raw.type === "string" ? raw.type : "generic";
  const externalId = typeof raw.external_id === "string" ? raw.external_id : "";
  if (!externalId) {
    throw new KernelValidationError("Entity external_id is required.");
  }
  const displayName = typeof raw.display_name === "string" ? raw.display_name : null;
  const attributes =
    raw.attributes && typeof raw.attributes === "object" && !Array.isArray(raw.attributes)
      ? (raw.attributes as Record<string, unknown>)
      : {};
  return { type, externalId, displayName, attributes };
}

function readMetrics(raw: unknown): { key: string; value: number; unit?: string }[] {
  if (!Array.isArray(raw)) {
    throw new InvalidMetricError("Metrics must be an array.");
  }
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new InvalidMetricError();
    }
    const row = item as Record<string, unknown>;
    if (typeof row.key !== "string" || !isValidMetricKey(row.key)) {
      throw new InvalidMetricError("Invalid metric key.");
    }
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
      throw new InvalidMetricError("Metric value must be a finite number.");
    }
    return {
      key: row.key,
      value: row.value,
      unit: typeof row.unit === "string" ? row.unit : undefined,
    };
  });
}

function assertConfidence(value: unknown): void {
  if (value == null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidConfidenceError();
  }
}

export async function normalizeSourceEvent(
  scoped: Database,
  event: SourceEventRow,
): Promise<{ status: "normalized" | "duplicate"; observationId: string; entityId: string }> {
  const existing = await getObservationBySourceEvent(scoped, {
    organizationId: event.organizationId,
    sourceEventId: event.id,
  });
  if (existing) {
    return {
      status: "duplicate",
      observationId: existing.id,
      entityId: existing.entityId ?? "",
    };
  }
  if (!isGenericEventType(event.eventType)) {
    throw new UnknownEventTypeError(event.eventType);
  }
  const entityInput = readEntity(event.entity);
  const metrics = readMetrics(event.metrics);
  assertConfidence(
    event.entity && typeof event.entity === "object" && "confidence" in event.entity
      ? event.entity.confidence
      : undefined,
  );

  const entityType = parseEntityType(entityInput.type);
  const identifierType = parseIdentifierType(entityType === "generic" ? entityInput.type : entityType);
  const normalizedValue = normalizeIdentifierValue(entityInput.externalId);
  const canonicalKey = canonicalEntityKey({
    entityType,
    sourceNamespace: SOURCE_NAMESPACE,
    identifierType,
    normalizedValue,
  });
  const entityId = deterministicId("ent", [event.organizationId, canonicalKey]);
  const identifierId = deterministicId("eid", [
    event.organizationId,
    SOURCE_NAMESPACE,
    identifierType,
    normalizedValue,
  ]);

  const mapped = await findEntityIdentifier(scoped, {
    organizationId: event.organizationId,
    sourceNamespace: SOURCE_NAMESPACE,
    identifierType,
    normalizedValue,
  });
  const savedEntity = mapped
    ? await getEntity(scoped, { organizationId: event.organizationId, id: mapped.entityId })
    : await insertEntity(scoped, {
        id: entityId,
        organizationId: event.organizationId,
        entityType,
        canonicalKey,
        displayName: entityInput.displayName,
        attributes: entityInput.attributes,
      });
  if (!savedEntity) {
    throw new KernelValidationError("Entity could not be resolved.");
  }
  if (!mapped) {
    await insertEntityIdentifier(scoped, {
      id: identifierId,
      organizationId: event.organizationId,
      entityId: savedEntity.id,
      sourceNamespace: SOURCE_NAMESPACE,
      identifierType,
      identifierValue: entityInput.externalId,
      normalizedValue,
    });
  }

  const observationId = event.id;
  const qualityFlag = metrics.length > 0 ? "complete" : "partial";
  await insertObservation(scoped, {
    id: observationId,
    organizationId: event.organizationId,
    entityId: savedEntity.id,
    sourceEventId: event.id,
    sourceNamespace: SOURCE_NAMESPACE,
    observationType: EVENT_TYPE_TO_OBSERVATION[event.eventType],
    observedAt: event.occurredAt,
    receivedAt: event.receivedAt,
    confidence: null,
    qualityFlag,
    attributes: { payload: event.payload, event_type: event.eventType },
  });
  for (const metric of metrics) {
    await insertObservationMetric(scoped, {
      id: deterministicId("met", [observationId, metric.key]),
      organizationId: event.organizationId,
      observationId,
      metricKey: metric.key,
      numericValue: numericToDecimalString(metric.value),
      textValue: null,
      unit: metric.unit,
    });
  }

  const evidenceId = deterministicId("evr", [event.organizationId, event.id]);
  await insertEvidenceReference(scoped, {
    id: evidenceId,
    organizationId: event.organizationId,
    evidenceType: "observation",
    sourceEventId: event.id,
    observationId,
    capturedAt: event.receivedAt,
    metadata: { event_type: event.eventType },
  });

  const features = {
    event_type: event.eventType,
    observation_type: EVENT_TYPE_TO_OBSERVATION[event.eventType],
    metrics: metrics.map((metric) => ({
      key: metric.key,
      value: numericToDecimalString(metric.value),
      unit: metric.unit ?? null,
    })),
  };
  const featureId = deterministicId("fs", [event.organizationId, event.id]);
  await insertFeatureSnapshot(scoped, {
    id: featureId,
    organizationId: event.organizationId,
    entityId: savedEntity.id,
    featureSetKey: FEATURE_SET_KEY,
    featureSetVersion: FEATURE_SET_VERSION,
    features,
    fingerprint: fingerprintFeatures(features),
    asOf: event.occurredAt,
  });

  const signalId = deterministicId("sig", [event.organizationId, event.id]);
  const first = metrics[0];
  await insertSignal(scoped, {
    id: signalId,
    organizationId: event.organizationId,
    entityId: savedEntity.id,
    signalType: "snapshot",
    direction: "unknown",
    magnitude: first ? numericToDecimalString(first.value) : null,
    confidence: "1.0000",
    validFrom: event.occurredAt,
    algorithmKey: ALGORITHM_KEY,
    algorithmVersion: ALGORITHM_VERSION,
    featureSnapshotId: featureId,
  });
  await insertSignalEvidence(scoped, {
    id: deterministicId("se", [signalId, evidenceId]),
    organizationId: event.organizationId,
    signalId,
    evidenceReferenceId: evidenceId,
    observationId,
    weight: "1.0000",
    role: "primary",
  });
  requireSignalEvidence(1);

  return { status: "normalized", observationId, entityId: savedEntity.id };
}

export { SOURCE_NAMESPACE, ALGORITHM_KEY, ALGORITHM_VERSION };
