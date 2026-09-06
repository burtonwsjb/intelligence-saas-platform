import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import {
  getOutboxJob,
  getPlatformOutbox,
  markOutboxPublishFailed,
  markOutboxPublished,
  markPlatformOutboxPublishFailed,
  markPlatformOutboxPublished,
  updateSourceEventStatus,
  withPlatformContext,
  withSystemContext,
  type Database,
} from "@isp/db";
import { QueueUnavailableError } from "./errors.js";
import { assertBullmqConnection, closeRedisConnection, createRedisConnection } from "./redis.js";
import { ingestQueueName } from "./names.js";
import { defaultIngestJobOptions } from "./lifecycle.js";
import { logQueueEvent, safeLoopErrorFields } from "./logger.js";
import type { JobEnvelope } from "./envelope.js";

export type IngestQueue = Queue<JobEnvelope>;

/** Keep database/envelope IDs intact, but give BullMQ a delimiter-safe key. */
export function bullmqJobId(outboxId: string): string {
  return `ispjob_${createHash("sha256").update(outboxId).digest("hex")}`;
}

const ownedQueueConnections = new WeakMap<IngestQueue, Redis>();

export function createIngestQueue(
  env: NodeJS.ProcessEnv = process.env,
  options?: { failFast?: boolean; connection?: Redis },
): IngestQueue {
  const owned = options?.connection
    ? undefined
    : createRedisConnection(env, { role: options?.failFast ? "failFast" : "queue" });
  const connection = options?.connection ?? owned;
  assertBullmqConnection(connection);
  const queue = new Queue<JobEnvelope>(ingestQueueName(env), {
    connection,
    skipVersionCheck: true,
    defaultJobOptions: defaultIngestJobOptions(),
  });
  if (owned) {
    ownedQueueConnections.set(queue, owned);
    const close = queue.close.bind(queue);
    queue.close = async () => {
      try {
        await close();
      } finally {
        await closeRedisConnection(owned);
      }
    };
  }
  return queue;
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
        jobId: bullmqJobId(row.id),
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
      }).catch((error) => {
        logQueueEvent("warn", "outbox.source_event_status_update_failed", {
          job_id: row.id,
          source_event_id: eventId,
          organization_id: input.organizationId,
          ...safeLoopErrorFields(error),
        });
      });
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
    const message = safeLoopErrorFields(error).error_class;
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

export async function publishPlatformOutboxJob(
  db: Database,
  input: { outboxId: string; queue?: IngestQueue; env?: NodeJS.ProcessEnv },
): Promise<{ published: boolean }> {
  const row = await withPlatformContext(db, (scoped) => getPlatformOutbox(scoped, input.outboxId));
  if (!row) {
    return { published: false };
  }
  if (row.status === "published" || row.status === "processed") {
    return { published: true };
  }
  let owned: IngestQueue | undefined;
  try {
    owned = input.queue ?? createIngestQueue(input.env, { failFast: true });
    try {
      await owned.add(row.jobType, row.payload as JobEnvelope, { jobId: bullmqJobId(row.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/already exists|duplicat/i.test(message)) {
        throw error;
      }
    }
    await withPlatformContext(db, (scoped) => markPlatformOutboxPublished(scoped, input.outboxId));
    logQueueEvent("info", "outbox.published", {
      job_id: row.id,
      job_type: row.jobType,
      status: "published",
    });
    return { published: true };
  } catch (error) {
    const message = safeLoopErrorFields(error).error_class;
    await withPlatformContext(db, (scoped) =>
      markPlatformOutboxPublishFailed(scoped, input.outboxId, message),
    );
    throw new QueueUnavailableError();
  } finally {
    if (!input.queue && owned) {
      await owned.close();
    }
  }
}
