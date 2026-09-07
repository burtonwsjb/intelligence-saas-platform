import { createFailureObserver, FAILURE_INSPECTION_INTERVAL_MS, recordTerminalPlatformFailure } from "./failure-observation.js";
import type { QueueFailureSnapshot } from "@isp/shared";
import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  applyProviderModeFromEnv,
  createDbConnection,
  createDbFromWorkerEnv,
  enqueueDueProviderSyncs,
  processQueuedEmailDeliveries,
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
  logRedisTransportProbe,
  markJobPermanentlyFailed,
  parseJobEnvelope,
  processNormalizeJob,
  readQueueJobCounts,
  requireRedisUrl,
  runGracefulStop,
  runRedisTransportProbe,
  safeLoopErrorFields,
  withDeadline,
  type IngestQueue,
  type JobEnvelope,
} from "@isp/queue";

export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_SWEEP_INTERVAL_MS = 5_000;
export const QUEUE_METRICS_TIMEOUT_MS = 8_000;
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

export async function reconcileProviderRuntimeFromEnv(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; errorClass: string | null }> {
  try {
    await withPlatformContext(db, (scoped) => applyProviderModeFromEnv(scoped, env));
    logQueueEvent("info", "worker.provider_runtime_synced", { status: "ok" });
    return { ok: true, errorClass: null };
  } catch (error) {
    logLoopFailure("worker.provider_runtime_sync_failed", "provider_runtime_sync", error);
    return { ok: false, errorClass: safeLoopErrorFields(error).error_class };
  }
}

export async function startProviderScheduleLoop(input: {
  db: Database;
  env?: NodeJS.ProcessEnv;
  onScheduleArm: () => void;
}): Promise<{ ok: boolean; errorClass: string | null }> {
  const result = await reconcileProviderRuntimeFromEnv(input.db, input.env);
  input.onScheduleArm();
  return result;
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

export async function collectQueueCounts(
  queue: QueueCounts,
  options?: { timeoutMs?: number },
): Promise<{
  queueDepth: number | null;
  failedJobs: number | null;
  errorClass: string | null;
}> {
  try {
    const counts = await withDeadline(
      queue.getJobCounts(),
      options?.timeoutMs ?? QUEUE_METRICS_TIMEOUT_MS,
      "queue_metrics_timeout",
    );
    const normalized = readQueueJobCounts(counts);
    return { ...normalized, errorClass: null };
  } catch (error) {
    const errorClass = safeLoopErrorFields(error).error_class;
    logLoopFailure("worker.queue_metrics_failed", "queue_metrics", error);
    return { queueDepth: null, failedJobs: null, errorClass };
  }
}

export async function runWorkerHeartbeat(
  db: Database,
  queue: QueueCounts,
  options?: { startup?: boolean; timeoutMs?: number; queueFailureSnapshot?: QueueFailureSnapshot | null },
): Promise<{ ok: boolean; errorClass: string | null }> {
  const counts = await collectQueueCounts(queue, { timeoutMs: options?.timeoutMs });
  try {
    await withPlatformContext(db, (scoped) =>
      upsertWorkerHeartbeat(scoped, {
        queueDepth: counts.queueDepth,
        failedJobs: counts.failedJobs,
        queueMetricsErrorClass: counts.errorClass,
        queueFailureSnapshot: options?.queueFailureSnapshot,
      }),
    );
    if (options?.startup) {
      if (counts.errorClass) {
        logQueueEvent("warn", "worker.queue_metrics_unavailable", {
          error_class: counts.errorClass,
          queue_depth: counts.queueDepth,
          failed_jobs: counts.failedJobs,
          status: "unknown",
        });
      } else {
        logQueueEvent("info", "worker.heartbeat_ok", {
          queue_depth: counts.queueDepth,
          failed_jobs: counts.failedJobs,
          status: "ok",
        });
      }
    }
    return { ok: true, errorClass: counts.errorClass };
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
  try {
    const env = input.env ?? process.env;
    const hosted = env.ISP_ENV === "staging" || env.ISP_ENV === "production";
    const configured = Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FROM_EMAIL?.trim());
    await withPlatformContext(db, (scoped) =>
      processQueuedEmailDeliveries(scoped, {
        send:
          hosted && configured
            ? async ({ templateKey }) => {
                const response = await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${env.RESEND_API_KEY}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    from: env.RESEND_FROM_EMAIL,
                    to: env.RESEND_OPERATOR_EMAIL ?? env.RESEND_FROM_EMAIL,
                    subject: templateKey,
                    text: "A Social Signal IQ notification is waiting in the app.",
                  }),
                });
                if (!response.ok) {
                  throw new Error("resend_failed");
                }
              }
            : undefined,
      }),
    );
  } catch (error) {
    logLoopFailure("worker.notification_fanout_failed", "notification_fanout", error);
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
  const queue = options?.queue ?? createIngestQueue(env);
  const workerConnection = createRedisConnection(env, { role: "worker" });
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
      connection: workerConnection,
      skipVersionCheck: true,
      ...defaultWorkerRuntimeOptions(),
    },
  );

  const failures = createFailureObserver(queue);
  void failures.refresh();
  const failureInspection = setInterval(() => {
    if (status !== "shutting_down" && status !== "stopped") void failures.refresh();
  }, FAILURE_INSPECTION_INTERVAL_MS);
  const pendingFailureWrites = new Set<Promise<unknown>>();
  worker.on("failed", (job, error) => {
    const pending = recordTerminalPlatformFailure(db, job, error).catch((failure) => {
      logLoopFailure("worker.terminal_failure_record_failed", "terminal_failure_record", failure);
    });
    pendingFailureWrites.add(pending);
    void pending.finally(() => pendingFailureWrites.delete(pending));
  });
  worker.on("error", (error) => logLoopFailure("worker.redis_error", "worker_connection", error));

  const sweep = setInterval(() => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runOutboxSweep(db, { queue, env });
  }, WORKER_SWEEP_INTERVAL_MS);

  const heartbeat = setInterval(() => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runWorkerHeartbeat(db, queue, { queueFailureSnapshot: failures.latest() }).then((result) => {
      if (result.ok) {
        lastHeartbeatAt = new Date().toISOString();
        lastHeartbeatErrorClass = null;
      } else {
        lastHeartbeatErrorClass = result.errorClass;
      }
    });
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  let providerSchedule: ReturnType<typeof setInterval> | undefined;
  void startProviderScheduleLoop({
    db,
    env,
    onScheduleArm: () => {
      if (status === "shutting_down" || status === "stopped") {
        return;
      }
      providerSchedule = setInterval(() => {
        if (status === "shutting_down" || status === "stopped") {
          return;
        }
        void runProviderSchedule(db, env);
      }, WORKER_HEARTBEAT_INTERVAL_MS);
    },
  });

  void runRedisTransportProbe({ env, queue })
    .then(logRedisTransportProbe)
    .catch((error) => {
      logQueueEvent("error", "redis.transport_probe", {
        stage: "connect",
        status: "failed",
        ...safeLoopErrorFields(error),
      });
    });

  void runWorkerHeartbeat(db, queue, { startup: true, queueFailureSnapshot: failures.latest() }).then((result) => {
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
              clearInterval(heartbeat);
              clearInterval(failureInspection);
              if (providerSchedule) {
                clearInterval(providerSchedule);
              }
            },
          },
          {
            name: "worker",
            run: async () => {
              await worker.close();
            },
          },
          {
            name: "terminal_failure_reporting",
            run: async () => { await Promise.all([...pendingFailureWrites]); },
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
              await closeRedisConnection(workerConnection);
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
