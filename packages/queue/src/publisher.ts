import { Queue } from "bullmq";
import {
  getOutboxJob,
  markOutboxPublishFailed,
  markOutboxPublished,
  updateSourceEventStatus,
  withSystemContext,
  type Database,
} from "@isp/db";
import { QueueUnavailableError } from "./errors.js";
import { createRedisConnection } from "./redis.js";
import { DEFAULT_BACKOFF_MS, DEFAULT_JOB_ATTEMPTS, ingestQueueName } from "./names.js";
import { logQueueEvent } from "./logger.js";
import type { JobEnvelope } from "./envelope.js";

export type IngestQueue = Queue<JobEnvelope>;

export function createIngestQueue(
  env: NodeJS.ProcessEnv = process.env,
  options?: { failFast?: boolean },
): IngestQueue {
  return new Queue<JobEnvelope>(ingestQueueName(env), {
    connection: createRedisConnection(env, options),
    defaultJobOptions: {
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
      removeOnComplete: 100,
      removeOnFail: false,
    },
  });
}

export async function publishOutboxJob(
  db: Database,
  input: {
    organizationId: string;
    outboxId: string;
    queue?: IngestQueue;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ published: boolean }> {
  const row = await withSystemContext(db, { organizationId: input.organizationId }, (scoped) =>
    getOutboxJob(scoped, { organizationId: input.organizationId, id: input.outboxId }),
  );
  if (!row) {
    return { published: false };
  }
  if (row.status === "published") {
    return { published: true };
  }
  let owned: IngestQueue | undefined;
  try {
    owned = input.queue ?? createIngestQueue(input.env, { failFast: true });
    try {
      await owned.add(row.jobType, row.payload as JobEnvelope, {
        jobId: row.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/already exists|duplicat/i.test(message)) {
        throw error;
      }
    }
    await withSystemContext(db, { organizationId: input.organizationId }, async (scoped) => {
      await markOutboxPublished(scoped, {
        organizationId: input.organizationId,
        id: input.outboxId,
      });
      const eventId = row.sourceEventId;
      await updateSourceEventStatus(scoped, {
        id: eventId,
        organizationId: input.organizationId,
        status: "queued",
      }).catch(() => undefined);
    });
    logQueueEvent("info", "outbox.published", {
      job_id: row.id,
      source_event_id: row.sourceEventId,
      organization_id: input.organizationId,
      job_type: row.jobType,
      status: "published",
    });
    return { published: true };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "queue unavailable")
      .replace(/redis:\/\/[^@\s]+@/gi, "redis://[redacted]@")
      .replace(/postgresql:\/\/[^@\s]+@/gi, "postgresql://[redacted]@");
    await withSystemContext(db, { organizationId: input.organizationId }, (scoped) =>
      markOutboxPublishFailed(scoped, {
        organizationId: input.organizationId,
        id: input.outboxId,
        error: message,
      }),
    );
    logQueueEvent("warn", "outbox.publish_failed", {
      job_id: row.id,
      source_event_id: row.sourceEventId,
      organization_id: input.organizationId,
      job_type: row.jobType,
      status: "pending",
    });
    throw new QueueUnavailableError();
  } finally {
    if (!input.queue && owned) {
      await owned.close();
    }
  }
}
