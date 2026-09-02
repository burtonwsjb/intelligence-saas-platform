import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  createDbConnection,
  createDbFromWorkerEnv,
  enqueueDueProviderSyncs,
  requireWorkerDatabaseUrl,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type Database,
} from "@isp/db";
import {
  JOB_TIMEOUT_MS,
  UnrecoverableJobError,
  closeRedisConnection,
  createIngestQueue,
  createRedisConnection,
  defaultWorkerRuntimeOptions,
  dispatchPendingOutbox,
  dispatchPendingPlatformOutbox,
  ingestQueueName,
  logQueueEvent,
  markJobPermanentlyFailed,
  parseJobEnvelope,
  processNormalizeJob,
  requireRedisUrl,
  runGracefulStop,
  safeLoopErrorFields,
  withDeadline,
  type IngestQueue,
  type JobEnvelope,
} from "@isp/queue";

export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_SWEEP_INTERVAL_MS = 5_000;
export const QUEUE_METRICS_TIMEOUT_MS = 2_500;
export const WORKER_SHUTDOWN_DRAIN_MS = 20_000;

type QueueCounts = Pick<IngestQueue, "getJobCounts">;

export type WorkerRuntimeStatus = "starting" | "running" | "shutting_down" | "stopped";

export type WorkerDiagnostics = {
  status: WorkerRuntimeStatus;
  started_at: string;
  shutting_down: boolean;
  last_heartbeat_at: string | null;
  last_heartbeat_error_class: string | null;
};

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
    const counts = await withDeadline(
      queue.getJobCounts("wait", "active", "failed"),
      QUEUE_METRICS_TIMEOUT_MS,
      "queue_metrics_timeout",
    );
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
  options?: { startup?: boolean },
): Promise<{ ok: boolean; errorClass: string | null }> {
  try {
    const counts = await collectQueueCounts(queue);
    await withPlatformContext(db, (scoped) =>
      upsertWorkerHeartbeat(scoped, {
        queueDepth: counts.queueDepth,
        failedJobs: counts.failedJobs,
      }),
    );
    if (options?.startup) {
      logQueueEvent("info", "worker.heartbeat_ok", {
        queue_depth: counts.queueDepth,
        failed_jobs: counts.failedJobs,
        status: "ok",
      });
    }
    return { ok: true, errorClass: null };
  } catch (error) {
    logLoopFailure("worker.heartbeat_failed", "worker_heartbeat", error);
    return { ok: false, errorClass: safeLoopErrorFields(error).error_class };
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

export function workerHealthPayload(diagnostics: WorkerDiagnostics): {
  status: "ok" | "shutting_down" | "stopped";
  worker: WorkerRuntimeStatus;
  started_at: string;
} {
  return {
    status:
      diagnostics.status === "shutting_down" || diagnostics.status === "stopped"
        ? diagnostics.status === "stopped"
          ? "stopped"
          : "shutting_down"
        : "ok",
    worker: diagnostics.status,
    started_at: diagnostics.started_at,
  };
}

export function startWorker(options?: {
  db?: Database;
  env?: NodeJS.ProcessEnv;
  queue?: IngestQueue;
}): {
  stop: () => Promise<void>;
  isShuttingDown: () => boolean;
  diagnostics: () => WorkerDiagnostics;
} {
  requireRedisUrl(options?.env);
  const env = options?.env ?? process.env;
  const ownedDb = options?.db ? null : createDbConnection(requireWorkerDatabaseUrl(env));
  const db = options?.db ?? ownedDb?.db ?? createDbFromWorkerEnv(env);
  const connection = createRedisConnection(env);
  const queue = options?.queue ?? createIngestQueue(env);
  const startedAt = new Date().toISOString();
  let status: WorkerRuntimeStatus = "starting";
  let lastHeartbeatAt: string | null = null;
  let lastHeartbeatErrorClass: string | null = null;

  const worker = new Worker<JobEnvelope>(
    ingestQueueName(env),
    async (job) => {
      try {
        await withDeadline(processNormalizeJob(db, job.data, job.attemptsMade + 1), JOB_TIMEOUT_MS, "job_timeout");
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
      ...defaultWorkerRuntimeOptions(),
    },
  );

  const sweep = setInterval(() => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runOutboxSweep(db, { queue, env });
  }, WORKER_SWEEP_INTERVAL_MS);

  const schedule = setInterval(() => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runProviderSchedule(db, env);
    void runWorkerHeartbeat(db, queue).then((result) => {
      if (result.ok) {
        lastHeartbeatAt = new Date().toISOString();
        lastHeartbeatErrorClass = null;
      } else {
        lastHeartbeatErrorClass = result.errorClass;
      }
    });
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  void runWorkerHeartbeat(db, queue, { startup: true }).then((result) => {
    if (result.ok) {
      lastHeartbeatAt = new Date().toISOString();
      lastHeartbeatErrorClass = null;
    } else {
      lastHeartbeatErrorClass = result.errorClass;
    }
  });

  status = "running";
  logQueueEvent("info", "worker.started", {
    job_type: "source_event.normalize",
    status: "received",
  });

  const diagnostics = (): WorkerDiagnostics => ({
    status,
    started_at: startedAt,
    shutting_down: status === "shutting_down",
    last_heartbeat_at: lastHeartbeatAt,
    last_heartbeat_error_class: lastHeartbeatErrorClass,
  });

  return {
    isShuttingDown: () => status === "shutting_down" || status === "stopped",
    diagnostics,
    stop: async () => {
      if (status === "stopped") {
        return;
      }
      status = "shutting_down";
      const result = await runGracefulStop(
        [
          {
            name: "intervals",
            run: async () => {
              clearInterval(sweep);
              clearInterval(schedule);
            },
          },
          {
            name: "worker",
            run: async () => {
              await worker.close();
            },
          },
          {
            name: "queue",
            run: async () => {
              if (!options?.queue) {
                await queue.close();
              }
            },
          },
          {
            name: "redis",
            run: async () => {
              await closeRedisConnection(connection);
            },
          },
          {
            name: "database",
            run: async () => {
              if (ownedDb) {
                await ownedDb.end();
              }
            },
          },
        ],
        { timeoutMs: WORKER_SHUTDOWN_DRAIN_MS },
      );
      status = "stopped";
      logQueueEvent("info", "worker.stopped", {
        timed_out: result.timedOut,
        failed_step: result.failedStep,
        completed: result.completed.join(","),
      });
    },
  };
}
