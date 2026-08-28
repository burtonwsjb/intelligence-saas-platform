import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { isProductionRuntime } from "@isp/shared";
import type { Database } from "../client.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import { extractCreatorCallsFromContent } from "../creator/ingest.js";
import { computeIndexLevel, listIndexDefinitions, persistIndexLevel, rebalanceIndex } from "../analytics/index-engine.js";
import { PREDICTION_HORIZONS } from "../prediction/catalog.js";
import { issuePrediction } from "../prediction/issue.js";
import { withPlatformContext } from "../rls.js";
import { scoreAndPersist } from "../scoring/persist.js";
import { crmOrganizationProfile } from "../schema/crm.js";
import { creator, creatorCall } from "../schema/creator.js";
import { outboxJob } from "../schema/ingest.js";
import { tcgIndexLevel } from "../schema/analytics.js";
import { platformAdmins } from "../schema/platform.js";
import { tcgPrediction } from "../schema/prediction.js";
import { tcgScoreSnapshot } from "../schema/scoring.js";
import { sourceMention } from "../schema/source.js";
import { tcgPrinting } from "../schema/tcg.js";
import { tcgMarketQuarantine, tcgMarketSnapshot } from "../schema/tcg-market.js";
import { sourceIntelligenceFixtures } from "../source/fixtures.js";
import { ingestSourceContentRecord } from "../source/ingest.js";
import { seedTcgIdentityFixtures } from "../tcg/fixtures.js";
import { tcgMarketFixtureRecords } from "../tcg/market-fixtures.js";
import { ingestTcgMarketRecord } from "../tcg/market-ingest.js";

export const STAGING_FIXTURE_AS_OF = new Date("2026-01-04T12:00:00.000Z");
export const STAGING_FIXTURE_PROVENANCE = "sandbox.fixture.v1";

export class StagingFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingFixtureError";
  }
}

export function assertStagingFixtureAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (isProductionRuntime(env)) {
    throw new StagingFixtureError(
      "Refusing to run the staging fixture pipeline in production.",
    );
  }
}

async function countRows(db: Database, table: PgTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return Number(row?.n ?? 0);
}

export type StagingFixtureVerification = {
  printings: number;
  creators: number;
  creatorCalls: number;
  marketSnapshots: number;
  sourceMentions: number;
  scores: number;
  indexLevels: number;
  predictions: number;
  predictionsPublished: number;
  marketQuarantine: number;
  outboxFailed: number;
  platformAdmins: number;
  customers: number;
};

export async function collectStagingFixtureVerification(
  db: Database,
): Promise<StagingFixtureVerification> {
  const published = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tcgPrediction)
    .where(sql`${tcgPrediction.visibility} <> 'shadow'`);
  const failedOutbox = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxJob)
    .where(eq(outboxJob.status, "failed"));
  return {
    printings: await countRows(db, tcgPrinting),
    creators: await countRows(db, creator),
    creatorCalls: await countRows(db, creatorCall),
    marketSnapshots: await countRows(db, tcgMarketSnapshot),
    sourceMentions: await countRows(db, sourceMention),
    scores: await countRows(db, tcgScoreSnapshot),
    indexLevels: await countRows(db, tcgIndexLevel),
    predictions: await countRows(db, tcgPrediction),
    predictionsPublished: Number(published[0]?.n ?? 0),
    marketQuarantine: await countRows(db, tcgMarketQuarantine),
    outboxFailed: Number(failedOutbox[0]?.n ?? 0),
    platformAdmins: await countRows(db, platformAdmins),
    customers: await countRows(db, crmOrganizationProfile),
  };
}

export function formatStagingFixtureReport(counts: StagingFixtureVerification): string {
  return [
    `provenance: ${STAGING_FIXTURE_PROVENANCE}`,
    `printings: ${counts.printings}`,
    `creators: ${counts.creators}`,
    `creatorCalls: ${counts.creatorCalls}`,
    `market_snapshots: ${counts.marketSnapshots}`,
    `source_mentions: ${counts.sourceMentions}`,
    `scores: ${counts.scores}`,
    `index_levels: ${counts.indexLevels}`,
    `predictions: ${counts.predictions}`,
    `predictions_published: ${counts.predictionsPublished}`,
    `market_quarantine: ${counts.marketQuarantine}`,
    `outbox_failed: ${counts.outboxFailed}`,
    `platform_admins: ${counts.platformAdmins}`,
    `customers: ${counts.customers}`,
  ].join("\n");
}

export async function runStagingFixturePipeline(db: Database): Promise<StagingFixtureVerification> {
  await withPlatformContext(db, async (scoped) => {
    const seeded = await seedTcgIdentityFixtures(scoped);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(scoped, record);
    }
    const sourceRecords = [...sourceIntelligenceFixtures(), ...creatorCallSourceFixtures()];
    const contentIds = new Set<string>();
    for (const record of sourceRecords) {
      const ingested = await ingestSourceContentRecord(scoped, record);
      if (ingested.contentId) {
        contentIds.add(ingested.contentId);
      }
    }
    for (const contentId of contentIds) {
      await extractCreatorCallsFromContent(scoped, contentId);
    }
    await scoreAndPersist(scoped, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: STAGING_FIXTURE_AS_OF,
    });
    const definitions = await listIndexDefinitions(scoped);
    for (const definition of definitions) {
      if (definition.status !== "active") {
        continue;
      }
      await rebalanceIndex(scoped, definition.indexKey, STAGING_FIXTURE_AS_OF);
      await persistIndexLevel(
        scoped,
        await computeIndexLevel(scoped, definition.indexKey, STAGING_FIXTURE_AS_OF),
      );
    }
    for (const horizon of PREDICTION_HORIZONS) {
      await issuePrediction(scoped, {
        printingId: seeded.printings.greninjaEnNormal.id,
        horizon,
        issuedAt: STAGING_FIXTURE_AS_OF,
      });
    }
  });
  return collectStagingFixtureVerification(db);
}
