import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { computeIndexLevel, listIndexDefinitions, persistIndexLevel } from "../analytics/index-engine.js";
import { extractCreatorCallsFromContent } from "../creator/ingest.js";
import { DEFAULT_PREDICTION_VISIBILITY } from "../prediction/catalog.js";
import { issuePrediction } from "../prediction/issue.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgScoreSnapshot } from "../schema/scoring.js";
import { scoreAndPersist } from "../scoring/persist.js";
import { enqueuePlatformJob, PLATFORM_JOB_VERSION, platformJobCreatedAt } from "./outbox.js";
import { stableMarketId } from "../tcg/market-identity.js";

export async function enqueueCreatorExtractJob(db: Database, contentId: string) {
  const id = `creator.extract.v1:${contentId}`;
  return enqueuePlatformJob(db, {
    id,
    jobType: "creator.extract.v1",
    payload: {
      job_version: PLATFORM_JOB_VERSION,
      job_type: "creator.extract.v1",
      job_id: id,
      content_id: contentId,
      created_at: platformJobCreatedAt(),
    },
  });
}

export async function enqueueIntelligenceRecomputeJob(db: Database, printingId: string, asOf: Date) {
  const id = `intelligence.recompute.v1:${printingId}:${asOf.toISOString()}`;
  return enqueuePlatformJob(db, {
    id,
    jobType: "intelligence.recompute.v1",
    payload: {
      job_version: PLATFORM_JOB_VERSION,
      job_type: "intelligence.recompute.v1",
      job_id: id,
      printing_id: printingId,
      as_of: asOf.toISOString(),
      created_at: platformJobCreatedAt(),
    },
  });
}

export async function processCreatorExtractJob(db: Database, contentId: string) {
  return extractCreatorCallsFromContent(db, contentId);
}

export async function processIntelligenceRecomputeJob(
  db: Database,
  input: { printingId: string; asOf: Date },
) {
  const [existing] = await db
    .select({ id: tcgScoreSnapshot.id })
    .from(tcgScoreSnapshot)
    .where(
      and(
        eq(tcgScoreSnapshot.printingId, input.printingId),
        eq(tcgScoreSnapshot.asOf, input.asOf),
      ),
    )
    .limit(1);
  const score = existing
    ? { id: existing.id, skipped: true as const }
    : { ...(await scoreAndPersist(db, { printingId: input.printingId, asOf: input.asOf })), skipped: false as const };

  const definitions = await listIndexDefinitions(db);
  let indices = 0;
  if (!score.skipped) {
    for (const definition of definitions) {
      const computed = await computeIndexLevel(db, definition.indexKey, input.asOf);
      if (computed) {
        await persistIndexLevel(db, computed);
        indices += 1;
      }
    }
  }

  let predictions = 0;
  if (!score.skipped) {
    const issued = await issuePrediction(db, {
      printingId: input.printingId,
      horizon: "30d",
      issuedAt: input.asOf,
      visibility: DEFAULT_PREDICTION_VISIBILITY,
    });
    if (issued.visibility !== "shadow") {
      throw new Error("Real-data recompute must not publish predictions.");
    }
    predictions += 1;
  }

  return {
    printingId: input.printingId,
    scoreSkipped: score.skipped,
    indices,
    predictions,
    publishedPredictions: 0,
  };
}

export async function enqueueRecomputeForSnapshot(db: Database, snapshotId: string) {
  const [row] = await db.select().from(tcgMarketSnapshot).where(eq(tcgMarketSnapshot.id, snapshotId)).limit(1);
  if (!row || row.outlierFlag) {
    return { enqueued: false };
  }
  return enqueueIntelligenceRecomputeJob(db, row.printingId, row.observedAt);
}

export function recomputeJobId(printingId: string, asOf: Date) {
  return stableMarketId("irc", [printingId, asOf.toISOString()]);
}
