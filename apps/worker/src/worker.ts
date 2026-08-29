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
  type IngestQueue,
  type JobEnvelope,
} from "@isp/queue";

export function startWorker(options?: {
  db?: Database;
  env?: NodeJS.ProcessEnv;
  queue?: IngestQueue;
}): { stop: () => Promise<void> } {
  requireRedisUrl(options?.env);
  const db = options?.db ?? createDbFromWorkerEnv(options?.env);
  const connection = createRedisConnection(options?.env);
  const queue = options?.queue ?? createIngestQueue(options?.env);
  const worker = new Worker<JobEnvelope>(
    ingestQueueName(options?.env),
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
    void dispatchPendingOutbox(db, { queue, env: options?.env }).catch(() => undefined);
    void dispatchPendingPlatformOutbox(db, { queue, env: options?.env }).catch(() => undefined);
  }, 5_000);

  const schedule = setInterval(() => {
    void withPlatformContext(db, async (scoped) => {
      await enqueueDueProviderSyncs(scoped, options?.env ?? process.env).catch(() => undefined);
      const counts = await queue.getJobCounts("wait", "active", "failed").catch(() => null);
      await upsertWorkerHeartbeat(scoped, {
        queueDepth: counts ? (counts.wait ?? 0) + (counts.active ?? 0) : null,
        failedJobs: counts?.failed ?? null,
      });
    }).catch(() => undefined);
  }, 15_000);

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
