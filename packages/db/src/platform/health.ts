import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgGame, tcgPrinting } from "../schema/tcg.js";
import { creator, creatorCall } from "../schema/creator.js";
import { tcgIndexDefinition, tcgIndexLevel } from "../schema/analytics.js";
import { contentPublication } from "../schema/content.js";
import { sourceDefinition } from "../schema/kernel.js";
import { sourceIngest, sourcePlatform } from "../schema/source.js";
import { tcgMarketIngest, tcgMarketQuarantine } from "../schema/tcg-market.js";
import { tcgPrediction } from "../schema/prediction.js";
import { webhookEndpoint } from "../schema/webhook.js";
import { crmOrganizationProfile } from "../schema/crm.js";
import {
  intelligenceQuarantine,
  platformOutbox,
  providerRuntime,
  workerHeartbeat,
} from "../schema/provider.js";
import { entityResolutionAttempt } from "../schema/resolution.js";
import { tcgScoreSnapshot } from "../schema/scoring.js";

export const WORKER_HEARTBEAT_STALE_MS = 60_000;
export const QUEUE_FAILED_JOBS_DEGRADED = 25;
export type WorkerHeartbeatStatus = "healthy" | "stale" | "missing";
export type PlatformHealthStatus = "healthy" | "degraded" | "stale" | "missing" | "failed";
export type QueueHealthStatus = "healthy" | "degraded" | "unknown";

export function classifyQueueHealth(input: {
  queueDepth: number | null;
  failedJobs: number | null;
  failedJobsHighWater?: number;
}): QueueHealthStatus {
  if (input.queueDepth == null && input.failedJobs == null) {
    return "unknown";
  }
  const highWater = input.failedJobsHighWater ?? QUEUE_FAILED_JOBS_DEGRADED;
  if ((input.failedJobs ?? 0) >= highWater) {
    return "degraded";
  }
  return "healthy";
}

export function classifyPlatformHealth(input: {
  worker: WorkerHeartbeatStatus;
  queue: QueueHealthStatus;
  database?: "ok" | "error";
  redis?: "configured" | "missing" | "error";
  providerFailed?: boolean;
}): PlatformHealthStatus {
  if (input.database === "error" || input.redis === "error") {
    return "failed";
  }
  if (input.worker === "missing") {
    return "missing";
  }
  if (input.worker === "stale") {
    return "stale";
  }
  if (input.queue === "degraded" || input.providerFailed) {
    return "degraded";
  }
  return "healthy";
}

export function operatorGuidanceForHealth(status: PlatformHealthStatus): string {
  switch (status) {
    case "failed":
      return "Database or Redis is not answering. Check Neon compute and Redis before restarting the worker.";
    case "missing":
      return "No ingest heartbeat row. Confirm the Railway worker process is running and using APP_DATABASE_URL.";
    case "stale":
      return "Heartbeat is older than 60s. The worker loop may be blocked; inspect worker logs for the last error_class.";
    case "degraded":
      return "Worker is alive but failed jobs or provider health need operator review. Do not enable live providers to clear this.";
    default:
      return "Worker heartbeat is fresh and queue metrics are within bounds.";
  }
}

export function classifyWorkerHeartbeat(
  lastSeenAt: Date | string | null | undefined,
  now = new Date(),
  staleAfterMs = WORKER_HEARTBEAT_STALE_MS,
): WorkerHeartbeatStatus {
  if (!lastSeenAt) {
    return "missing";
  }
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(seen.getTime())) {
    return "missing";
  }
  return now.getTime() - seen.getTime() > staleAfterMs ? "stale" : "healthy";
}

export async function collectSystemHealth(db: Database) {
  const [
    games,
    printings,
    creators,
    calls,
    indices,
    publications,
    predictions,
    customers,
    quarantine,
    failingWebhooks,
    intelQuarantine,
    failedJobs,
    failedMarket,
    failedSource,
    failedResolution,
    failedScores,
    failedIndices,
    failedPredictions,
    providers,
    heartbeat,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(tcgGame),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgPrinting),
    db.select({ count: sql<number>`count(*)::int` }).from(creator),
    db.select({ count: sql<number>`count(*)::int` }).from(creatorCall),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgIndexDefinition),
    db.select({ count: sql<number>`count(*)::int` }).from(contentPublication),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgPrediction),
    db.select({ count: sql<number>`count(*)::int` }).from(crmOrganizationProfile),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgMarketQuarantine),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEndpoint)
      .where(sql`${webhookEndpoint.consecutiveFailures} > 0`),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(intelligenceQuarantine)
      .where(sql`${intelligenceQuarantine.resolutionState} = 'open'`),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(platformOutbox)
      .where(sql`${platformOutbox.status} = 'failed'`),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tcgMarketIngest)
      .where(sql`${tcgMarketIngest.processingStatus} = 'failed'`),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceIngest)
      .where(sql`${sourceIngest.processingStatus} = 'failed'`),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(entityResolutionAttempt)
      .where(sql`${entityResolutionAttempt.status} in ('unresolved', 'ambiguous', 'conflict')`),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgScoreSnapshot),
    db.select({ count: sql<number>`count(*)::int` }).from(tcgIndexLevel),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tcgPrediction)
      .where(sql`${tcgPrediction.dataQuality} = 'insufficient_data'`),
    db.select().from(providerRuntime),
    db.select().from(workerHeartbeat),
  ]);

  const ingestByStatus = await db
    .select({
      key: sourceIngest.processingStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceIngest)
    .groupBy(sourceIngest.processingStatus);

  const platforms = await db.select().from(sourcePlatform);
  const sources = await db.select().from(sourceDefinition);
  const worker = heartbeat.find((row) => row.workerKey === "ingest") ?? heartbeat[0] ?? null;
  const workerHeartbeatStatus = classifyWorkerHeartbeat(worker?.lastSeenAt);
  const queueHealth = classifyQueueHealth({
    queueDepth: worker?.queueDepth ?? null,
    failedJobs: worker?.failedJobs ?? null,
  });
  const providerFailed = providers.some((row) => row.healthStatus === "failed");
  const redis = process.env.REDIS_URL?.trim() ? "configured" : "missing";
  const overall = classifyPlatformHealth({
    worker: workerHeartbeatStatus,
    queue: queueHealth,
    database: "ok",
    redis,
    providerFailed,
  });

  return {
    version: "health.v3" as const,
    catalogs: {
      games: Number(games[0]?.count ?? 0),
      printings: Number(printings[0]?.count ?? 0),
      creators: Number(creators[0]?.count ?? 0),
      creatorCalls: Number(calls[0]?.count ?? 0),
      indices: Number(indices[0]?.count ?? 0),
      publications: Number(publications[0]?.count ?? 0),
      predictions: Number(predictions[0]?.count ?? 0),
      customers: Number(customers[0]?.count ?? 0),
      marketQuarantine: Number(quarantine[0]?.count ?? 0),
      failingWebhooks: Number(failingWebhooks[0]?.count ?? 0),
      intelligenceQuarantineOpen: Number(intelQuarantine[0]?.count ?? 0),
      failedJobs: Number(failedJobs[0]?.count ?? 0),
    },
    status: overall,
    guidance: operatorGuidanceForHealth(overall),
    operations: {
      database: "ok",
      redis,
      workerHeartbeatAt: worker?.lastSeenAt?.toISOString() ?? null,
      workerHeartbeatStatus,
      queueHealth,
      queueDepth: worker?.queueDepth ?? null,
      failedJobs: worker?.failedJobs ?? null,
      normalizationFailures: Number(failedMarket[0]?.count ?? 0) + Number(failedSource[0]?.count ?? 0),
      resolutionFailures: Number(failedResolution[0]?.count ?? 0),
      scoringSnapshots: Number(failedScores[0]?.count ?? 0),
      indexLevels: Number(failedIndices[0]?.count ?? 0),
      predictionInsufficient: Number(failedPredictions[0]?.count ?? 0),
    },
    providers: providers.map((row) => ({
      provider: row.providerKey,
      type: row.providerType,
      mode: row.mode,
      enabled: row.enabled,
      paused: row.paused,
      credentialStatus: row.credentialStatus,
      health: row.healthStatus,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastErrorClass: row.lastErrorClass,
      rateLimitRemaining: row.rateLimitRemaining,
      retryAfterAt: row.retryAfterAt?.toISOString() ?? null,
      recordsIngested: row.recordsIngested,
      recordsQuarantined: row.recordsQuarantined,
      checkpoint: row.lastSourceId,
      scheduleSeconds: row.scheduleSeconds,
    })),
    ingestByStatus,
    platforms: platforms.map((row) => ({ sourceType: row.sourceType, status: row.status })),
    sourceDefinitions: sources.map((row) => ({
      sourceKey: row.sourceKey,
      sourceType: row.sourceType,
      status: row.status,
    })),
  };
}

export function describePlatformConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    billingMode: env.BILLING_MODE?.trim() || "local",
    emailMode: env.AUTH_EMAIL_MODE?.trim() || "file",
    predictionsCustomerVisible: env.PREDICTIONS_CUSTOMER_VISIBLE === "true",
    trialDurationDays: env.TRIAL_DURATION_DAYS?.trim() || "14",
    databaseConfigured: Boolean(env.APP_DATABASE_URL?.trim() || env.DATABASE_URL?.trim()),
    adminRolePasswordConfigured: Boolean(env.APP_ADMIN_PASSWORD?.trim()),
    databaseAdminUrlConfigured: Boolean(env.DATABASE_ADMIN_URL?.trim()),
    redisConfigured: Boolean(env.REDIS_URL?.trim()),
    stripeConfigured: Boolean(env.STRIPE_SECRET_KEY?.trim()),
    resendConfigured: Boolean(env.RESEND_API_KEY?.trim()),
    tccConfigured: Boolean(env.TCC_API_TOKEN?.trim()),
  };
}
