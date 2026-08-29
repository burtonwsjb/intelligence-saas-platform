import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  createDbFromWorkerEnv,
  enqueueDueProviderSyncs,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type Database,
} from "@isp/db";
import {
  UnrecoverableJobError,
  createIngestQueue,
  createRedisConnection,
  dispatchPendingOutbox,
  dispatchPendingPlatformOutbox,
  ingestQueueName,
  logQueueEvent,
  markJobPermanentlyFailed,
  parseJobEnvelope,
  processNormalizeJob,
  requireRedisUrl,
  safeLoopErrorFields,
  type IngestQueue,
  type JobEnvelope,
} from "@isp/queue";

export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_SWEEP_INTERVAL_MS = 5_000;

type QueueCounts = Pick<IngestQueue, "getJobCounts">;

function logLoopFailure(event: string, operation: string, error: unknown) {
  logQueueEvent("error", event, {
    operation,
    ...safeLoopErrorFields(error),
    retry: "next_cycle",
  });
}

export async function runProviderSchedule(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await withPlatformContext(db, (scoped) => enqueueDueProviderSyncs(scoped, env));
  } catch (error) {
    logLoopFailure("worker.scheduler_failed", "provider_scheduler", error);
  }
}

export async function collectQueueCounts(queue: QueueCounts): Promise<{
  queueDepth: number | null;
  failedJobs: number | null;
}> {
  try {
    const counts = await queue.getJobCounts("wait", "active", "failed");
    return {
      queueDepth: (counts.wait ?? 0) + (counts.active ?? 0),
      failedJobs: counts.failed ?? 0,
    };
  } catch (error) {
    logLoopFailure("worker.queue_metrics_failed", "queue_metrics", error);
    return { queueDepth: null, failedJobs: null };
  }
}

export async function runWorkerHeartbeat(
  db: Database,
  queue: QueueCounts,
): Promise<void> {
  try {
    const counts = await collectQueueCounts(queue);
    await withPlatformContext(db, (scoped) =>
      upsertWorkerHeartbeat(scoped, {
        queueDepth: counts.queueDepth,
        failedJobs: counts.failedJobs,
      }),
    );
  } catch (error) {
    logLoopFailure("worker.heartbeat_failed", "worker_heartbeat", error);
  }
}

export async function runOutboxSweep(
  db: Database,
  input: { queue: IngestQueue; env?: NodeJS.ProcessEnv },
): Promise<void> {
  try {
    await dispatchPendingOutbox(db, input);
  } catch (error) {
    logLoopFailure("worker.outbox_dispatch_failed", "outbox_dispatch", error);
  }
  try {
    await dispatchPendingPlatformOutbox(db, input);
  } catch (error) {
    logLoopFailure("worker.platform_outbox_dispatch_failed", "platform_outbox_dispatch", error);
  }
}

export function startWorker(options?: {
  db?: Database;
  env?: NodeJS.ProcessEnv;
  queue?: IngestQueue;
}): { stop: () => Promise<void> } {
  requireRedisUrl(options?.env);
  const env = options?.env ?? process.env;
  const db = options?.db ?? createDbFromWorkerEnv(env);
  const connection = createRedisConnection(env);
  const queue = options?.queue ?? createIngestQueue(env);
  const worker = new Worker<JobEnvelope>(
    ingestQueueName(env),
    async (job) => {
      try {
        await processNormalizeJob(db, job.data, job.attemptsMade + 1);
      } catch (error) {
        if (error instanceof UnrecoverableJobError) {
          try {
            const envelope = parseJobEnvelope(job.data);
            await markJobPermanentlyFailed(db, envelope, error.message);
          } catch {
            // envelope may itself be invalid
          }
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    {
      connection,
      concurrency: 4,
    },
  );

  const sweep = setInterval(() => {
    void runOutboxSweep(db, { queue, env });
  }, WORKER_SWEEP_INTERVAL_MS);

  const schedule = setInterval(() => {
    void runProviderSchedule(db, env);
    void runWorkerHeartbeat(db, queue);
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  void runWorkerHeartbeat(db, queue);

  logQueueEvent("info", "worker.started", {
    job_type: "source_event.normalize",
    status: "received",
  });

  return {
    stop: async () => {
      clearInterval(sweep);
      clearInterval(schedule);
      await worker.close();
      if (!options?.queue) {
        await queue.close();
      }
      connection.disconnect();
    },
  };
}
