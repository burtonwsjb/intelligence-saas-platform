import { createHash } from "node:crypto";
import { z } from "zod";
import {
  findSourceEventByIdempotency,
  insertAuditEvent,
  insertOutboxJob,
  insertSourceEvent,
  recordUsage,
  type Database,
} from "@isp/db";
import { assertQuota, assertTenantFeature } from "@isp/billing";
import { isGenericEventType, METRIC_KEY_PATTERN } from "@isp/contracts";
import { createNormalizeEnvelope } from "@isp/queue";

export const INGEST_MAX_BYTES = 65_536;

export class IngestValidationError extends Error {
  readonly code = "validation_error";
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

export class IngestPayloadTooLargeError extends Error {
  readonly code = "payload_too_large";
  constructor() {
    super(`Ingest payload exceeds ${INGEST_MAX_BYTES} bytes.`);
    this.name = "IngestPayloadTooLargeError";
  }
}

export class IngestIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor() {
    super("Idempotency key was reused with a different payload.");
    this.name = "IngestIdempotencyConflictError";
  }
}

const ingestBodySchema = z.object({
  event_type: z
    .string()
    .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/)
    .max(64),
  occurred_at: z.string().datetime(),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  entity: z.object({
    type: z.string().min(1).max(64),
    external_id: z.string().min(1).max(128),
    display_name: z.string().max(200).optional(),
    attributes: z.record(z.unknown()).optional(),
  }),
  metrics: z
    .array(
      z.object({
        key: z.string().regex(METRIC_KEY_PATTERN).max(64),
        value: z.number(),
        unit: z.string().max(32).optional(),
      }),
    )
    .max(50)
    .default([]),
  payload: z.record(z.unknown()).default({}),
});

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

export function fingerprintIngest(body: z.infer<typeof ingestBodySchema>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          event_type: body.event_type,
          occurred_at: body.occurred_at,
          entity: body.entity,
          metrics: body.metrics,
          payload: body.payload,
        }),
      ),
    )
    .digest("hex");
}

export function parseIngestBody(raw: string): z.infer<typeof ingestBodySchema> {
  if (Buffer.byteLength(raw, "utf8") > INGEST_MAX_BYTES) {
    throw new IngestPayloadTooLargeError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IngestValidationError("Body must be JSON.");
  }
  const body = ingestBodySchema.safeParse(parsed);
  if (!body.success) {
    throw new IngestValidationError("Ingest payload is invalid.");
  }
  if (!isGenericEventType(body.data.event_type)) {
    throw new IngestValidationError("Unknown event type.");
  }
  const occurred = Date.parse(body.data.occurred_at);
  if (Number.isNaN(occurred) || occurred > Date.now() + 24 * 60 * 60 * 1000) {
    throw new IngestValidationError("occurred_at is invalid.");
  }
  return body.data;
}

export async function acceptIngestEvent(
  scoped: Database,
  input: {
    organizationId: string;
    apiKeyId: string;
    requestId: string;
    body: z.infer<typeof ingestBodySchema>;
  },
): Promise<{ event_id: string; accepted: true; duplicate: boolean; outbox_id: string | null }> {
  const fingerprint = fingerprintIngest(input.body);
  const existing = await findSourceEventByIdempotency(scoped, {
    organizationId: input.organizationId,
    idempotencyKey: input.body.idempotency_key,
  });
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new IngestIdempotencyConflictError();
    }
    return { event_id: existing.id, accepted: true, duplicate: true, outbox_id: null };
  }

  await assertTenantFeature(scoped, input.organizationId, "api_requests_per_month");
  await assertQuota(scoped, {
    organizationId: input.organizationId,
    meterKey: "ingest.events",
  });

  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  await insertSourceEvent(scoped, {
    id: eventId,
    organizationId: input.organizationId,
    eventType: input.body.event_type,
    occurredAt: new Date(input.body.occurred_at),
    idempotencyKey: input.body.idempotency_key,
    requestId: input.requestId,
    fingerprint,
    entity: input.body.entity,
    metrics: input.body.metrics,
    payload: input.body.payload,
    createdByApiKeyId: input.apiKeyId,
  });
  await insertOutboxJob(scoped, {
    id: outboxId,
    organizationId: input.organizationId,
    sourceEventId: eventId,
    jobType: "source_event.normalize",
    payload: createNormalizeEnvelope({
      jobId: outboxId,
      organizationId: input.organizationId,
      sourceEventId: eventId,
      requestId: input.requestId,
    }),
  });
  await recordUsage(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    apiKeyId: input.apiKeyId,
    meterKey: "ingest.events",
    quantity: 1,
    idempotencyKey: `ingest:${input.body.idempotency_key}`,
  });
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    action: "source_event.accepted",
    targetType: "source_event",
    targetId: eventId,
    metadata: { event_type: input.body.event_type, request_id: input.requestId },
  });

  return { event_id: eventId, accepted: true, duplicate: false, outbox_id: outboxId };
}
