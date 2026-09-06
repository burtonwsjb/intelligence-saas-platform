import {
  getSourceEvent,
  getPlatformOutbox,
  getTenant,
  IdentifierCollisionError,
  InvalidConfidenceError,
  InvalidMetricError,
  KernelValidationError,
  MissingSignalEvidenceError,
  SourceValidationError,
  TcgMarketRevisionError,
  TcgMarketValidationError,
  UnknownEventTypeError,
  insertAuditEvent,
  markSourceIngestFailed,
  markTcgMarketIngestFailed,
  normalizeSourceEvent,
  normalizeSourceIntelligenceIngest,
  normalizeTcgMarketIngest,
  processCreatorExtractJob,
  processIntelligenceRecomputeJob,
  syncProvider,
  markPlatformOutboxFailed,
  markPlatformOutboxProcessed,
  enqueueCreatorExtractJob,
  enqueueRecomputeForSnapshot,
  updateSourceEventStatus,
  withPlatformContext,
  withSystemContext,
  type Database,
} from "@isp/db";
import { UnrecoverableJobError } from "./errors.js";
import { parseJobEnvelope, type JobEnvelope } from "./envelope.js";
import { logQueueEvent, safeLoopErrorFields } from "./logger.js";

function safeFailureMessage(message: string): string {
  return message.replace(/isp_(?:test|live)_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

function toUnrecoverable(error: unknown): never {
  if (
    error instanceof UnknownEventTypeError ||
    error instanceof InvalidMetricError ||
    error instanceof InvalidConfidenceError ||
    error instanceof KernelValidationError ||
    error instanceof IdentifierCollisionError ||
    error instanceof MissingSignalEvidenceError ||
    error instanceof TcgMarketRevisionError ||
    error instanceof TcgMarketValidationError ||
    error instanceof SourceValidationError
  ) {
    throw new UnrecoverableJobError(error.message);
  }
  throw error;
}

async function processMarketNormalizeJob(
  db: Database,
  envelope: Extract<JobEnvelope, { job_type: "tcg.market.normalize.v1" }>,
  attempt: number,
): Promise<{ status: "processed" | "duplicate" }> {
  logQueueEvent("info", "job.started", {
    job_id: envelope.job_id,
    market_ingest_id: envelope.market_ingest_id,
    job_type: envelope.job_type,
    request_id: envelope.request_id,
    attempt,
    status: "processing",
  });
  try {
    const result = await withPlatformContext(db, async (scoped) => {
      const normalized = await normalizeTcgMarketIngest(scoped, envelope.market_ingest_id);
      if (normalized.snapshotId) await enqueueRecomputeForSnapshot(scoped, normalized.snapshotId);
      await markPlatformOutboxProcessed(scoped, envelope.job_id);
      return normalized;
    });
    const status = result.status === "duplicate" ? ("duplicate" as const) : ("processed" as const);
    logQueueEvent("info", "job.processed", {
      job_id: envelope.job_id,
      market_ingest_id: envelope.market_ingest_id,
      job_type: envelope.job_type,
      attempt,
      status,
    });
    return { status };
  } catch (error) {
    toUnrecoverable(error);
  }
}

async function processSourceNormalizeJob(
  db: Database,
  envelope: Extract<JobEnvelope, { job_type: "source.intelligence.normalize.v1" }>,
  attempt: number,
): Promise<{ status: "processed" | "duplicate" }> {
  logQueueEvent("info", "job.started", {
    job_id: envelope.job_id,
    source_ingest_id: envelope.source_ingest_id,
    job_type: envelope.job_type,
    request_id: envelope.request_id,
    attempt,
    status: "processing",
  });
  try {
    const result = await withPlatformContext(db, async (scoped) => {
      const normalized = await normalizeSourceIntelligenceIngest(scoped, envelope.source_ingest_id);
      if (normalized.contentId) await enqueueCreatorExtractJob(scoped, normalized.contentId);
      await markPlatformOutboxProcessed(scoped, envelope.job_id);
      return normalized;
    });
    const status = result.status === "duplicate" ? ("duplicate" as const) : ("processed" as const);
    logQueueEvent("info", "job.processed", {
      job_id: envelope.job_id,
      source_ingest_id: envelope.source_ingest_id,
      job_type: envelope.job_type,
      attempt,
      status,
    });
    return { status };
  } catch (error) {
    toUnrecoverable(error);
  }
}

async function processProviderSyncJob(
  db: Database,
  envelope: Extract<JobEnvelope, { job_type: "provider.sync.v1" }>,
  attempt: number,
): Promise<{ status: "processed" | "duplicate" }> {
  logQueueEvent("info", "job.started", {
    job_id: envelope.job_id,
    job_type: envelope.job_type,
    attempt,
    status: "processing",
  });
  try {
    const existing = await withPlatformContext(db, (tx) => getPlatformOutbox(tx, envelope.job_id));
    if (existing?.status === "processed") return { status: "duplicate" };
    const result = await syncProvider(db, {
      providerKey: envelope.provider_key,
      trigger: envelope.trigger ?? "schedule",
      limit: envelope.limit,
      query: envelope.discovery_query,
    });
    if (result.status === "failed" || result.reason === "overlap") {
      throw new Error(result.reason ?? "provider_sync_failed");
    }
    await withPlatformContext(db, (scoped) => markPlatformOutboxProcessed(scoped, envelope.job_id));
    return { status: result.status === "skipped" ? "duplicate" : "processed" };
  } catch (error) {
    toUnrecoverable(error);
  }
}

async function processCreatorExtractQueueJob(
  db: Database,
  envelope: Extract<JobEnvelope, { job_type: "creator.extract.v1" }>,
): Promise<{ status: "processed" | "duplicate" }> {
  try {
    await withPlatformContext(db, (scoped) => processCreatorExtractJob(scoped, envelope.content_id));
    await withPlatformContext(db, (scoped) => markPlatformOutboxProcessed(scoped, envelope.job_id));
    return { status: "processed" };
  } catch (error) {
    toUnrecoverable(error);
  }
}

async function processIntelligenceRecomputeQueueJob(
  db: Database,
  envelope: Extract<JobEnvelope, { job_type: "intelligence.recompute.v1" }>,
): Promise<{ status: "processed" | "duplicate" }> {
  try {
    await withPlatformContext(db, (scoped) =>
      processIntelligenceRecomputeJob(scoped, {
        printingId: envelope.printing_id,
        asOf: new Date(envelope.as_of),
      }),
    );
    await withPlatformContext(db, (scoped) => markPlatformOutboxProcessed(scoped, envelope.job_id));
    return { status: "processed" };
  } catch (error) {
    toUnrecoverable(error);
  }
}

export async function processNormalizeJob(
  db: Database,
  raw: unknown,
  attempt = 1,
): Promise<{ status: "processed" | "duplicate" }> {
  const envelope = parseJobEnvelope(raw);
  if (envelope.job_type === "tcg.market.normalize.v1") {
    return processMarketNormalizeJob(db, envelope, attempt);
  }
  if (envelope.job_type === "source.intelligence.normalize.v1") {
    return processSourceNormalizeJob(db, envelope, attempt);
  }
  if (envelope.job_type === "provider.sync.v1") {
    return processProviderSyncJob(db, envelope, attempt);
  }
  if (envelope.job_type === "creator.extract.v1") {
    return processCreatorExtractQueueJob(db, envelope);
  }
  if (envelope.job_type === "intelligence.recompute.v1") {
    return processIntelligenceRecomputeQueueJob(db, envelope);
  }
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
  if (envelope.job_type === "tcg.market.normalize.v1") {
    await withPlatformContext(db, (scoped) =>
      markTcgMarketIngestFailed(scoped, envelope.market_ingest_id),
    ).catch((error) => {
      logQueueEvent("warn", "job.permanent_failure_side_effect", {
        job_id: envelope.job_id,
        job_type: envelope.job_type,
        ...safeLoopErrorFields(error),
      });
    });
    logQueueEvent("error", "job.permanent_failure", {
      job_id: envelope.job_id,
      market_ingest_id: envelope.market_ingest_id,
      job_type: envelope.job_type,
      status: "failed",
    });
    return;
  }
  if (envelope.job_type === "source.intelligence.normalize.v1") {
    await withPlatformContext(db, (scoped) =>
      markSourceIngestFailed(scoped, envelope.source_ingest_id),
    ).catch((error) => {
      logQueueEvent("warn", "job.permanent_failure_side_effect", {
        job_id: envelope.job_id,
        job_type: envelope.job_type,
        ...safeLoopErrorFields(error),
      });
    });
    logQueueEvent("error", "job.permanent_failure", {
      job_id: envelope.job_id,
      source_ingest_id: envelope.source_ingest_id,
      job_type: envelope.job_type,
      status: "failed",
    });
    return;
  }
  if (
    envelope.job_type === "provider.sync.v1" ||
    envelope.job_type === "creator.extract.v1" ||
    envelope.job_type === "intelligence.recompute.v1"
  ) {
    await withPlatformContext(db, (scoped) =>
      markPlatformOutboxFailed(scoped, envelope.job_id, safeFailureMessage(message)),
    ).catch((error) => {
      logQueueEvent("warn", "job.permanent_failure_side_effect", {
        job_id: envelope.job_id,
        job_type: envelope.job_type,
        ...safeLoopErrorFields(error),
      });
    });
    logQueueEvent("error", "job.permanent_failure", {
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      status: "failed",
    });
    return;
  }
  await withSystemContext(db, { organizationId: envelope.organization_id }, async (scoped) => {
    await updateSourceEventStatus(scoped, {
      id: envelope.source_event_id,
      organizationId: envelope.organization_id,
      status: "failed",
      failureCategory: "permanent",
      failureMessage: safeFailureMessage(message),
    }).catch((error) => {
      logQueueEvent("warn", "job.permanent_failure_side_effect", {
        job_id: envelope.job_id,
        job_type: envelope.job_type,
        ...safeLoopErrorFields(error),
      });
    });
    await insertAuditEvent(scoped, {
      id: crypto.randomUUID(),
      organizationId: envelope.organization_id,
      action: "job.permanent_failure",
      targetType: "source_event",
      targetId: envelope.source_event_id,
      metadata: { job_id: envelope.job_id },
    }).catch((error) => {
      logQueueEvent("warn", "job.permanent_failure_side_effect", {
        job_id: envelope.job_id,
        job_type: envelope.job_type,
        ...safeLoopErrorFields(error),
      });
    });
  });
  logQueueEvent("error", "job.permanent_failure", {
    job_id: envelope.job_id,
    source_event_id: envelope.source_event_id,
    organization_id: envelope.organization_id,
    job_type: envelope.job_type,
    status: "failed",
  });
}
