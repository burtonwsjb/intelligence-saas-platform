import {
  getSourceEvent,
  getTenant,
  IdentifierCollisionError,
  InvalidConfidenceError,
  InvalidMetricError,
  KernelValidationError,
  MissingSignalEvidenceError,
  UnknownEventTypeError,
  insertAuditEvent,
  normalizeSourceEvent,
  updateSourceEventStatus,
  withSystemContext,
  type Database,
} from "@isp/db";
import { UnrecoverableJobError } from "./errors.js";
import { parseJobEnvelope, type JobEnvelope } from "./envelope.js";
import { logQueueEvent } from "./logger.js";

function safeFailureMessage(message: string): string {
  return message.replace(/isp_test_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

function toUnrecoverable(error: unknown): never {
  if (
    error instanceof UnknownEventTypeError ||
    error instanceof InvalidMetricError ||
    error instanceof InvalidConfidenceError ||
    error instanceof KernelValidationError ||
    error instanceof IdentifierCollisionError ||
    error instanceof MissingSignalEvidenceError
  ) {
    throw new UnrecoverableJobError(error.message);
  }
  throw error;
}

export async function processNormalizeJob(
  db: Database,
  raw: unknown,
  attempt = 1,
): Promise<{ status: "processed" | "duplicate" }> {
  const envelope = parseJobEnvelope(raw);
  logQueueEvent("info", "job.started", {
    job_id: envelope.job_id,
    source_event_id: envelope.source_event_id,
    organization_id: envelope.organization_id,
    job_type: envelope.job_type,
    request_id: envelope.request_id,
    attempt,
    status: "processing",
  });

  return withSystemContext(db, { organizationId: envelope.organization_id }, async (scoped) => {
    const tenantRow = await getTenant(scoped, envelope.organization_id);
    if (!tenantRow || tenantRow.status !== "active") {
      throw new UnrecoverableJobError("Tenant is not active.");
    }
    const event = await getSourceEvent(scoped, {
      organizationId: envelope.organization_id,
      id: envelope.source_event_id,
    });
    if (!event) {
      throw new UnrecoverableJobError("Source event is missing.");
    }
    if (event.organizationId !== envelope.organization_id) {
      await insertAuditEvent(scoped, {
        id: crypto.randomUUID(),
        organizationId: envelope.organization_id,
        action: "job.permanent_failure",
        targetType: "source_event",
        targetId: event.id,
        metadata: { reason: "tenant_mismatch" },
      });
      throw new UnrecoverableJobError("Job tenant does not match source event.");
    }
    if (event.processingStatus === "processed") {
      return { status: "duplicate" as const };
    }
    await updateSourceEventStatus(scoped, {
      id: event.id,
      organizationId: envelope.organization_id,
      status: "processing",
    });
    try {
      await normalizeSourceEvent(scoped, event);
    } catch (error) {
      toUnrecoverable(error);
    }
    await updateSourceEventStatus(scoped, {
      id: event.id,
      organizationId: envelope.organization_id,
      status: "processed",
      failureCategory: null,
      failureMessage: null,
    });
    logQueueEvent("info", "job.processed", {
      job_id: envelope.job_id,
      source_event_id: envelope.source_event_id,
      organization_id: envelope.organization_id,
      job_type: envelope.job_type,
      attempt,
      status: "processed",
    });
    return { status: "processed" as const };
  });
}

export async function markJobPermanentlyFailed(
  db: Database,
  envelope: JobEnvelope,
  message: string,
): Promise<void> {
  await withSystemContext(db, { organizationId: envelope.organization_id }, async (scoped) => {
    await updateSourceEventStatus(scoped, {
      id: envelope.source_event_id,
      organizationId: envelope.organization_id,
      status: "failed",
      failureCategory: "permanent",
      failureMessage: safeFailureMessage(message),
    }).catch(() => undefined);
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: envelope.organization_id,
      action: "job.permanent_failure",
      targetType: "source_event",
      targetId: envelope.source_event_id,
      metadata: { job_id: envelope.job_id },
    }).catch(() => undefined);
  });
  logQueueEvent("error", "job.permanent_failure", {
    job_id: envelope.job_id,
    source_event_id: envelope.source_event_id,
    organization_id: envelope.organization_id,
    job_type: envelope.job_type,
    status: "failed",
  });
}
