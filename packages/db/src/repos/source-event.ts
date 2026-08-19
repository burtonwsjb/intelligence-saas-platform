import { and, eq } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import { canTransitionSourceEvent, type SourceEventStatus } from "../ingest-status.js";
import { sourceEvent } from "../schema/ingest.js";
import type { Database } from "../client.js";

export class IllegalSourceEventTransitionError extends Error {
  constructor() {
    super("Illegal source event status transition.");
    this.name = "IllegalSourceEventTransitionError";
  }
}

export async function insertSourceEvent(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    eventType: string;
    occurredAt: Date;
    idempotencyKey: string;
    requestId?: string | null;
    fingerprint: string;
    entity: Record<string, unknown>;
    metrics: unknown[];
    payload: Record<string, unknown>;
    createdByApiKeyId?: string | null;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped.insert(sourceEvent).values({
    id: input.id,
    organizationId: input.organizationId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    fingerprint: input.fingerprint,
    entity: input.entity,
    metrics: input.metrics,
    payload: input.payload,
    processingStatus: "received",
    createdByApiKeyId: input.createdByApiKeyId,
  });
}

export async function findSourceEventByIdempotency(
  scoped: Database,
  input: { organizationId: string; idempotencyKey: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(sourceEvent)
    .where(
      and(
        eq(sourceEvent.organizationId, input.organizationId),
        eq(sourceEvent.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getSourceEvent(
  scoped: Database,
  input: { organizationId: string; id: string },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(sourceEvent)
    .where(and(eq(sourceEvent.organizationId, input.organizationId), eq(sourceEvent.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function listSourceEvents(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select({
      id: sourceEvent.id,
      organizationId: sourceEvent.organizationId,
      processingStatus: sourceEvent.processingStatus,
      idempotencyKey: sourceEvent.idempotencyKey,
    })
    .from(sourceEvent)
    .where(eq(sourceEvent.organizationId, organizationId));
}

export async function updateSourceEventStatus(
  scoped: Database,
  input: {
    id: string;
    organizationId: string;
    status: SourceEventStatus;
    failureCategory?: "transient" | "permanent" | null;
    failureMessage?: string | null;
  },
): Promise<number> {
  await assertTenantContext(scoped);
  const current = await getSourceEvent(scoped, {
    id: input.id,
    organizationId: input.organizationId,
  });
  if (!current) {
    return 0;
  }
  if (!canTransitionSourceEvent(current.processingStatus, input.status)) {
    throw new IllegalSourceEventTransitionError();
  }
  const updated = await scoped
    .update(sourceEvent)
    .set({
      processingStatus: input.status,
      failureCategory:
        input.failureCategory !== undefined ? input.failureCategory : current.failureCategory,
      failureMessage:
        input.failureMessage !== undefined ? input.failureMessage : current.failureMessage,
      updatedAt: new Date(),
    })
    .where(
      and(eq(sourceEvent.id, input.id), eq(sourceEvent.organizationId, input.organizationId)),
    )
    .returning({ id: sourceEvent.id });
  return updated.length;
}
