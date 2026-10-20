import { createFailureObserver, FAILURE_INSPECTION_INTERVAL_MS, recordTerminalPlatformFailure } from "./failure-observation.js";
import type { QueueFailureSnapshot } from "@isp/shared";
import { Worker } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  applyProviderModeFromEnv,
  chartSentimentBatchSize,
  createDbConnection,
  createDbFromWorkerEnv,
  createTranscriptFetcherFromEnv,
  enqueueDueProviderSyncs,
  importTccCatalog,
  processQueuedEmailDeliveries,
  requireWorkerDatabaseUrl,
  resolveProviderMode,
  runChartSentimentBatch,
  runTranscriptBackfillBatch,
  runWebBackfill,
  runYoutubeBackfill,
  scoreDueCreatorCalls,
  syncSealedProducts,
  syncSetAssets,
  rescanAssetCalls,
  syncTccPriceHistory,
  retryUnboundDetectedMentions,
  traceSourcePost,
  syncWebFeeds,
  transcriptProviderConfig,
  transcriptRequestBudget,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type ChartSentimentRunReport,
  type Database,
  type TccCatalogReport,
  type TccPriceHistoryReport,
  type TranscriptBackfillReport,
  type TranscriptFetcher,
  type WebBackfillReport,
  type MentionRetryReport,
  type AssetCallRescanReport,
  type WebFeedSyncReport,
  type YoutubeBackfillReport,
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
  execution_mode?: "continuous" | "scheduled";
  next_scheduled_at?: string;
  time_zone?: string;
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

/**
 * The hourly market work, one step after another: the TCG Card Central card
 * catalog (with card pictures), sealed products and a set asset for any new
 * set, transcript card mentions for new YouTube videos (when a transcript
 * provider is configured), posts from registered influencer websites (when
 * PROVIDER_WEB_FEED_MODE=live), the 12-month YouTube and website backfills
 * (when their *_BACKFILL_DAYS are set), TCC price history for calls without
 * prices and the chart universe, scoring of calls that have come due, then a
 * batch of Chart Sentiment. Every step is bounded and catches its own errors.
 * Postgres and HTTP only: no Redis, so the scheduled free-only worker runs it
 * after each batch as well.
 */
export async function runMarketWork(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runTccCatalogImport(db, env);
  await runSealedCatalogSync(db);
  await runSetCatalogSync(db);
  await runTranscriptBackfill(db, env);
  await runWebFeedSync(db, env);
  await runYoutubeUploadsBackfill(db, env);
  await runWebSitemapBackfill(db, env);
  await runMentionRetry(db);
  await runAssetCallRescan(db);
  await runPostTrace(db, env);
  await runPriceHistory(db, env);
  await runCallScoring(db);
  await runChartSentiment(db, env);
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

/** Postgres check_violation: market_asset rejects kind 'set' until migration 0034 is applied. */
function isCheckViolation(error: unknown) {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23514";
}

/**
 * Adds a set asset for any new set, so posts that call a whole set become
 * calls. Database only. Skips (logged) until migration 0034 is applied.
 */
export async function runSetCatalogSync(db: Database) {
  try {
    const report = await withPlatformContext(db, (scoped) => syncSetAssets(scoped));
    if (report.added > 0) logQueueEvent("info", "worker.set_catalog", { status: "ok", added: report.added });
    return report;
  } catch (error) {
    if (isCheckViolation(error)) {
      logQueueEvent("info", "worker.set_catalog", { status: "skipped", reason: "migration_0034_missing" });
      return null;
    }
    logLoopFailure("worker.set_catalog_failed", "set_catalog", error);
    return null;
  }
}

/**
 * Reads set and sealed-product calls out of posts stored before those assets
 * existed, a bounded batch per run behind a cursor. Database only.
 */
export async function runAssetCallRescan(db: Database): Promise<AssetCallRescanReport | null> {
  try {
    const report = await rescanAssetCalls(db);
    if (report.scanned > 0) {
      logQueueEvent("info", "worker.asset_call_rescan", {
        status: "completed",
        scanned: report.scanned,
        calls_created: report.callsCreated,
        failed: report.failed,
      });
    }
    return report;
  } catch (error) {
    logLoopFailure("worker.asset_call_rescan_failed", "asset_call_rescan", error);
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
 * Gives card mentions from posts and transcripts that the resolver left
 * unbound one more try after the resolver improves (MENTION_RETRY_KEY), a
 * bounded batch per run. Database only; logs counts.
 */
export async function runMentionRetry(db: Database): Promise<MentionRetryReport | null> {
  try {
    const report = await retryUnboundDetectedMentions(db);
    if (report.scanned > 0) {
      logQueueEvent("info", "worker.mention_retry", {
        status: "completed",
        scanned: report.scanned,
        retried: report.retried,
        bound: report.bound,
        calls_created: report.callsCreated,
      });
    }
    return report;
  } catch (error) {
    logLoopFailure("worker.mention_retry_failed", "mention_retry", error);
    return null;
  }
}

/**
 * When MENTION_TRACE_URL is set, logs what was stored for that one post
 * (site reads, its mentions and how each resolved) and, with
 * MENTION_TRACE_CARD, the catalog printings for that card name. Read only;
 * for finding why a post does not count toward a card.
 */
export async function runPostTrace(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = env.MENTION_TRACE_URL?.trim();
  if (!url) return;
  try {
    const trace = await traceSourcePost(db, { url, cardName: env.MENTION_TRACE_CARD?.trim() || null });
    logQueueEvent("info", "worker.post_trace", { trace: JSON.stringify(trace).slice(0, 60_000) });
  } catch (error) {
    logLoopFailure("worker.post_trace_failed", "post_trace", error);
  }
}

type YoutubeBackfillTransport = NonNullable<Parameters<typeof runYoutubeBackfill>[1]>["transport"];

/**
 * Walks the uploads of monitored YouTube channels back twelve months (seeded
 * influencers first) through the official Data API, and turns card names in
 * video titles and descriptions into mentions and creator calls. Runs only
 * with YOUTUBE_BACKFILL_DAYS set and YouTube live; bounded by
 * YOUTUBE_BACKFILL_REQUESTS_PER_DAY inside the shared YouTube data budget,
 * and resumes from each channel's checkpoint. Logs counts only.
 */
export async function runYoutubeUploadsBackfill(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  options: { transport?: YoutubeBackfillTransport } = {},
): Promise<YoutubeBackfillReport | null> {
  try {
    const report = await runYoutubeBackfill(db, { env, transport: options.transport });
    if (report.status === "skipped" && report.reason === "disabled") return report;
    logQueueEvent(report.status === "stopped" ? "warn" : "info", "worker.youtube_backfill", {
      status: report.status,
      reason: report.reason,
      channels: report.channels,
      finished: report.finished,
      requests: report.requests,
      pages: report.pages,
      videos: report.videos,
      stored: report.stored,
      mentions: report.mentions,
      calls_created: report.callsCreated,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.youtube_backfill_failed", "youtube_backfill", error);
    return null;
  }
}

/**
 * Reads registered influencer websites' sitemaps for posts of the last
 * WEB_FEED_BACKFILL_DAYS days, within robots.txt, the per-site daily cap and
 * the shared WEB_FEED_REQUESTS_PER_DAY budget. Logs counts only, never a URL.
 */
export async function runWebSitemapBackfill(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  options: { transport?: WebFeedTransport; lookup?: WebFeedLookup } = {},
): Promise<WebBackfillReport | null> {
  try {
    const report = await runWebBackfill(db, { env, transport: options.transport, lookup: options.lookup });
    if (report.status === "skipped" && (report.reason === "disabled" || report.reason === "web_feed_not_live")) return report;
    logQueueEvent(report.status === "stopped" ? "warn" : "info", "worker.web_backfill", {
      status: report.status,
      reason: report.reason,
      sites: report.sites,
      finished: report.finished,
      requests: report.requests,
      sitemaps: report.sitemaps,
      pages: report.pages,
      posts: report.posts,
      mentions: report.mentions,
      calls_created: report.callsCreated,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.web_backfill_failed", "web_backfill", error);
    return null;
  }
}

type PriceHistoryTransport = NonNullable<Parameters<typeof syncTccPriceHistory>[1]>["transport"];

/**
 * Fetches daily TCG Card Central price history for printings whose calls lack
 * a price at the call or at the horizon end, so backfilled calls can be
 * scored, then for the chart universe (English Pokemon / One Piece) so Chart
 * Sentiment has a year of prices. Runs only when TCC is live with its URL and
 * token; bounded by TCC_PRICE_HISTORY_ITEMS_PER_RUN plus
 * TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN printings in requests of at most 50.
 */
export async function runPriceHistory(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  options: { transport?: PriceHistoryTransport; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TccPriceHistoryReport | null> {
  try {
    const report = await syncTccPriceHistory(db, { env, transport: options.transport, sleep: options.sleep });
    if (report.status === "skipped" && report.reason !== "throttled" && report.reason !== "overlap") return report;
    // Reaching the points cap is the normal end of a chart universe run.
    const level = report.status === "stopped" && report.reason !== "points_cap" ? "warn" : "info";
    logQueueEvent(level, "worker.price_history", {
      status: report.status,
      reason: report.reason,
      printings: report.printings,
      chart_printings: report.chartPrintings,
      requests: report.requests,
      ok: report.ok,
      pending: report.pending,
      not_found: report.notFound,
      failed: report.failed,
      points: report.points,
      written: report.written,
      deferred: report.deferred,
      outcomes_reset: report.outcomesReset,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.price_history_failed", "price_history", error);
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

/**
 * Chart Sentiment: scores up to CHART_SENTIMENT_BATCH_SIZE printings (default
 * 200, 0 = off) whose chart was not computed in the last 20 hours, from the
 * market rows already stored, and refreshes the pattern database's measured
 * hit rates. Database-only. Skips (logged) until migration 0033 is applied;
 * an advisory lock keeps two replicas from scoring the same batch.
 */
export async function runChartSentiment(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
  asOf = new Date(),
): Promise<ChartSentimentRunReport | null> {
  try {
    const batchSize = chartSentimentBatchSize(env);
    if (batchSize === 0) return null;
    const report = await withPlatformContext(db, (scoped) => runChartSentimentBatch(scoped, { asOf, batchSize, exclusive: true }));
    logQueueEvent(report.reason === "tables_missing" ? "warn" : "info", "worker.chart_sentiment", {
      status: report.status,
      reason: report.reason,
      considered: report.considered,
      printings: report.printings,
      segments: report.segments,
      failed: report.failed,
      patterns_updated: report.patternsUpdated,
    });
    return report;
  } catch (error) {
    logLoopFailure("worker.chart_sentiment_failed", "chart_sentiment", error);
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
  await runEmailDeliverySweep(db, input.env);
}

/** Sends queued notification email. Uses Postgres and Resend only, never Redis. */
export async function runEmailDeliverySweep(db: Database, envInput?: NodeJS.ProcessEnv): Promise<void> {
  try {
    const env = envInput ?? process.env;
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

  // Hourly, and once a minute after startup (see runMarketWork).
  const runMarketWorkLoop = () => {
    if (status === "shutting_down" || status === "stopped") {
      return;
    }
    void runMarketWork(db, env);
  };
  const firstMarketWork = setTimeout(runMarketWorkLoop, 60_000);
  const callScoring = setInterval(runMarketWorkLoop, CALL_SCORING_INTERVAL_MS);

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
