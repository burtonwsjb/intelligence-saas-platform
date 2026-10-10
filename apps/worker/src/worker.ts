import { createFailureObserver, FAILURE_INSPECTION_INTERVAL_MS, recordTerminalPlatformFailure } from "./failure-observation.js";
import type { QueueFailureSnapshot } from "@isp/shared";
import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  applyProviderModeFromEnv,
  createDbConnection,
  createDbFromWorkerEnv,
  createTranscriptFetcherFromEnv,
  enqueueDueProviderSyncs,
  importTccCatalog,
  processQueuedEmailDeliveries,
  requireWorkerDatabaseUrl,
  resolveProviderMode,
  runTranscriptBackfillBatch,
  scoreDueCreatorCalls,
  syncSealedProducts,
  syncWebFeeds,
  transcriptProviderConfig,
  transcriptRequestBudget,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type Database,
  type TccCatalogReport,
  type TranscriptBackfillReport,
  type TranscriptFetcher,
  type WebFeedSyncReport,
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
export const CALL_SCORING_INTERVAL_MS = 60 * 60 * 1000;

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

/**
 * Arms the provider scheduler after reconciling provider runtime with env.
 * With TCG Card Central live, one bounded catalog import runs first, so the
 * first price collection already sees the imported catalog.
 */
export async function startProviderScheduleLoop(input: {
  db: Database;
  env?: NodeJS.ProcessEnv;
  onScheduleArm: () => void;
  tccTransport?: TccTransport;
}): Promise<{ ok: boolean; errorClass: string | null }> {
  const result = await reconcileProviderRuntimeFromEnv(input.db, input.env);
  await runTccCatalogImport(input.db, input.env, input.tccTransport);
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

type TccTransport = Parameters<typeof importTccCatalog>[1]["transport"];

/**
 * Imports a bounded slice of TCG Card Central's card catalog (at most
 * TCC_CATALOG_MAX_REQUESTS requests). Runs only with
 * PROVIDER_TCG_CARD_CENTRAL_MODE=live and TCC_API_BASE_URL / TCC_API_TOKEN set;
 * an advisory lock keeps two worker replicas from importing at once.
 */
export async function runTccCatalogImport(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  transport?: TccTransport,
): Promise<TccCatalogReport | null> {
  const baseUrl = env.TCC_API_BASE_URL?.trim();
  const token = env.TCC_API_TOKEN?.trim();
  if (resolveProviderMode("tcg_card_central", env) !== "live" || !baseUrl || !token) {
    return null;
  }
  try {
    const report = await withPlatformContext(db, (scoped) =>
      importTccCatalog(scoped, { baseUrl, token, transport, exclusive: true }),
    );
    logQueueEvent(report.status === "failed" ? "warn" : "info", "worker.tcc_catalog", {
      status: report.status,
      reason: report.reason,
      requests: report.requests,
      cards: report.cards,
      printings: report.printings,
      sets: report.sets,
      already_imported: report.alreadyImported,
      malformed: report.malformed,
      unsupported_language: report.unsupportedLanguage,
      collisions: report.collisions,
      conflicts: report.conflicts,
      rejected: report.rejected,
      sweep_complete: report.sweepComplete,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.tcc_catalog_failed", "tcc_catalog", error);
    return null;
  }
}

/** Adds the standard sealed products for any new set. Database only. */
export async function runSealedCatalogSync(db: Database) {
  try {
    const report = await withPlatformContext(db, (scoped) => syncSealedProducts(scoped));
    if (report.added > 0) logQueueEvent("info", "worker.sealed_catalog", { status: "ok", added: report.added });
    return report;
  } catch (error) {
    logLoopFailure("worker.sealed_catalog_failed", "sealed_catalog", error);
    return null;
  }
}

/**
 * Fetches transcripts for the newest unchecked YouTube videos and stores the
 * card mentions in them, so creator calls can bind to the printing a creator
 * names. Runs only when TRANSCRIPT_PROVIDER selects a provider
 * (`youtube_captions`, or `supadata` with SUPADATA_API_KEY); nothing is enabled
 * by default. Bounded by YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY (Pacific day) and
 * at most TRANSCRIPT_BACKFILL_MAX_VIDEOS_PER_RUN videos per run; an advisory
 * lock serializes claims across worker replicas. Logs counts only, never a
 * URL or key.
 */
export async function runTranscriptBackfill(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: TranscriptFetcher,
): Promise<TranscriptBackfillReport | null> {
  const config = transcriptProviderConfig(env);
  if (!config.enabled) {
    if (config.reason !== "disabled") {
      logQueueEvent("warn", "worker.transcript_backfill", { status: "skipped", reason: config.reason });
    }
    return null;
  }
  try {
    const budget = transcriptRequestBudget(env);
    const active = fetcher ?? createTranscriptFetcherFromEnv(env);
    if (!active) return null;
    const report = await runTranscriptBackfillBatch(db, active, { budget });
    logQueueEvent(report.status === "stopped" ? "warn" : "info", "worker.transcript_backfill", {
      status: report.status,
      reason: report.reason,
      provider: active.provider,
      considered: report.considered,
      checked: report.checked,
      ingested: report.ingested,
      no_mentions: report.noMentions,
      unavailable: report.unavailable,
      failed: report.failed,
      segments: report.segments,
      mentions: report.mentions,
      calls_created: report.callsCreated,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.transcript_backfill_failed", "transcript_backfill", error);
    return null;
  }
}

type WebFeedTransport = NonNullable<Parameters<typeof syncWebFeeds>[1]>["transport"];
type WebFeedLookup = NonNullable<Parameters<typeof syncWebFeeds>[1]>["lookup"];

/**
 * Reads the RSS/Atom feeds of the influencer websites an operator registered
 * and turns card names in new posts into mentions and creator calls. Runs
 * only with PROVIDER_WEB_FEED_MODE=live; honors robots.txt, at most
 * WEB_FEED_MAX_SITES_PER_RUN sites per run, WEB_FEED_MAX_REQUESTS_PER_SITE
 * requests per site and WEB_FEED_REQUESTS_PER_DAY requests per Pacific day.
 * Logs counts only, never a URL or post text.
 */
export async function runWebFeedSync(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  options: { transport?: WebFeedTransport; lookup?: WebFeedLookup } = {},
): Promise<WebFeedSyncReport | null> {
  if (resolveProviderMode("web_feed", env) !== "live") {
    return null;
  }
  try {
    const report = await syncWebFeeds(db, { env, transport: options.transport, lookup: options.lookup });
    logQueueEvent(report.status === "stopped" || report.failed > 0 ? "warn" : "info", "worker.web_feed_sync", {
      status: report.status,
      reason: report.reason,
      sites: report.sites,
      checked: report.checked,
      not_modified: report.notModified,
      skipped: report.skipped,
      failed: report.failed,
      requests: report.requests,
      posts: report.posts,
      new_posts: report.newPosts,
      mentions: report.mentions,
      calls_created: report.callsCreated,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.web_feed_sync_failed", "web_feed_sync", error);
    return null;
  }
}

/**
 * Scores creator calls whose horizon has passed and refreshes the affected
 * creators' authority. Database-only: it makes no provider requests. An
 * advisory lock keeps two worker replicas from scoring the same batch.
 */
export async function runCallScoring(db: Database, asOf = new Date()) {
  try {
    const report = await withPlatformContext(db, (scoped) => scoreDueCreatorCalls(scoped, { asOf, exclusive: true }));
    logQueueEvent("info", "worker.call_scoring", report
      ? {
          status: "ok",
          considered: report.considered,
          evaluated: report.evaluated,
          insufficient: report.insufficient,
          failed: report.failed,
          creators_recomputed: report.creatorsRecomputed,
          more_creators_waiting: report.moreCreatorsWaiting,
        }
      : { status: "skipped", reason: "overlap" });
    return report;
  } catch (error) {
    logLoopFailure("worker.call_scoring_failed", "call_scoring", error);
    return null;
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

  // Hourly, and once a minute after startup: the TCG Card Central card
  // catalog, sealed products for any new set, transcript card mentions for
  // new YouTube videos (when a transcript provider is configured), posts from
  // registered influencer websites (when PROVIDER_WEB_FEED_MODE=live), then
  // scoring of calls that have come due.
  const runMarketWork = () => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runTccCatalogImport(db, env)
      .then(() => runSealedCatalogSync(db))
      .then(() => runTranscriptBackfill(db, env))
      .then(() => runWebFeedSync(db, env))
      .then(() => runCallScoring(db));
  };
  const firstMarketWork = setTimeout(runMarketWork, 60_000);
  const callScoring = setInterval(runMarketWork, CALL_SCORING_INTERVAL_MS);

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
              clearInterval(callScoring);
              clearTimeout(firstMarketWork);
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
