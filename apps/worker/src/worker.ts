import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { createDbFromWorkerEnv, type Database } from "@isp/db";
import {
  UnrecoverableJobError,
  createIngestQueue,
  createRedisConnection,
  dispatchPendingOutbox,
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
    void dispatchPendingOutbox(db, { queue, env: options?.env }).catch((error) => {
      logQueueEvent("warn", "outbox.sweep_failed", {
        status: "pending",
        job_type: "source_event.normalize",
        attempt: 0,
      });
      void error;
    });
  }, 5_000);

  logQueueEvent("info", "worker.started", {
    job_type: "source_event.normalize",
    status: "received",
  });

  return {
    stop: async () => {
      clearInterval(sweep);
      await worker.close();
      if (!options?.queue) {
        await queue.close();
      }
      connection.disconnect();
    },
  };
}
