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
  const worker = heartbeat[0] ?? null;

  return {
    version: "health.v2" as const,
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
    operations: {
      database: "ok",
      redis: process.env.REDIS_URL?.trim() ? "configured" : "missing",
      workerHeartbeatAt: worker?.lastSeenAt?.toISOString() ?? null,
      queueDepth: worker?.queueDepth ?? null,
      failedJobs: Number(failedJobs[0]?.count ?? 0),
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
