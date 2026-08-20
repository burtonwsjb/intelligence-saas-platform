import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgGame, tcgPrinting } from "../schema/tcg.js";
import { creator, creatorCall } from "../schema/creator.js";
import { tcgIndexDefinition } from "../schema/analytics.js";
import { contentPublication } from "../schema/content.js";
import { sourceDefinition } from "../schema/kernel.js";
import { sourceIngest, sourcePlatform } from "../schema/source.js";
import { tcgMarketQuarantine } from "../schema/tcg-market.js";
import { tcgPrediction } from "../schema/prediction.js";
import { webhookEndpoint } from "../schema/webhook.js";
import { crmOrganizationProfile } from "../schema/crm.js";

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

  return {
    version: "health.v1" as const,
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
    },
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
    databaseConfigured: Boolean(env.DATABASE_URL?.trim()),
    adminRolePasswordConfigured: Boolean(env.APP_ADMIN_PASSWORD?.trim()),
    databaseAdminUrlConfigured: Boolean(env.DATABASE_ADMIN_URL?.trim()),
    redisConfigured: Boolean(env.REDIS_URL?.trim()),
    stripeConfigured: Boolean(env.STRIPE_SECRET_KEY?.trim()),
    resendConfigured: Boolean(env.RESEND_API_KEY?.trim()),
    tccConfigured: Boolean(env.TCC_API_TOKEN?.trim()),
  };
}
