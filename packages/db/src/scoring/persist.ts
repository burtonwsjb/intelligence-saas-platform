import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgScoreSnapshot } from "../schema/scoring.js";
import { getDecisionRecord, insertDecisionRecord } from "../repos/decision.js";
import { SCORE_POLICY_KEY } from "./weights.js";
import { gatherScoreInputs } from "./gather.js";
import { scoreFromInputs } from "./model.js";
import { ensureTcgPrintingEntity } from "../tcg/kernel-link.js";
import { tcgPrinting } from "../schema/tcg.js";

export async function scorePrinting(db: Database, input: { printingId: string; asOf: Date; scoreVersion?: string }) {
  const gathered = await gatherScoreInputs(db, input);
  return scoreFromInputs(gathered);
}

export async function persistScoreSnapshot(
  db: Database,
  scored: ReturnType<typeof scoreFromInputs>,
) {
  const asOf = new Date(scored.asOf);
  const [existing] = await db
    .select()
    .from(tcgScoreSnapshot)
    .where(
      and(
        eq(tcgScoreSnapshot.printingId, scored.printingId),
        eq(tcgScoreSnapshot.asOf, asOf),
        eq(tcgScoreSnapshot.scoreVersion, scored.scoreVersion),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }
  const [row] = await db
    .insert(tcgScoreSnapshot)
    .values({
      id: crypto.randomUUID(),
      printingId: scored.printingId,
      asOf,
      scoreVersion: scored.scoreVersion,
      policyKey: scored.policyKey,
      policyVersion: scored.policyVersion,
      recommendationVersion: scored.recommendationVersion,
      featureSnapshotId: scored.featureSnapshotId,
      opportunityScore: scored.opportunity.toFixed(4),
      riskScore: scored.risk.toFixed(4),
      confidenceScore: scored.confidence.toFixed(4),
      liquidityScore: scored.liquidity.toFixed(4),
      recommendation: scored.recommendation,
      uncalibrated: scored.uncalibrated ? "true" : "false",
      dataQuality: scored.dataQuality,
      languageCode: scored.languageCode,
      components: scored.components,
      explanations: scored.explanations,
    })
    .returning();
  return row!;
}

export async function getLatestScoreSnapshot(db: Database, printingId: string, asOf?: Date) {
  const rows = await db
    .select()
    .from(tcgScoreSnapshot)
    .where(eq(tcgScoreSnapshot.printingId, printingId))
    .orderBy(desc(tcgScoreSnapshot.asOf));
  return rows.find((row) => (asOf ? row.asOf.getTime() <= asOf.getTime() : true)) ?? null;
}

export async function projectScoreToDecision(
  db: Database,
  input: { organizationId: string; scoreId: string },
) {
  const [score] = await db.select().from(tcgScoreSnapshot).where(eq(tcgScoreSnapshot.id, input.scoreId)).limit(1);
  if (!score) {
    throw new Error("score snapshot not found.");
  }
  const [printing] = await db.select().from(tcgPrinting).where(eq(tcgPrinting.id, score.printingId)).limit(1);
  const entity = await ensureTcgPrintingEntity(db, {
    organizationId: input.organizationId,
    printing: {
      id: printing!.id,
      canonicalPrintingKey: printing!.canonicalPrintingKey,
      collectorNumber: printing!.collectorNumber,
    },
  });
  const decisionId = `dec_score_${score.id}_${input.organizationId}`.slice(0, 128);
  const existing = await getDecisionRecord(db, { organizationId: input.organizationId, id: decisionId });
  if (existing) {
    return existing;
  }
  await insertDecisionRecord(db, {
    id: decisionId,
    organizationId: input.organizationId,
    entityId: entity.id,
    decisionType: "tcg.opportunity.recommendation",
    status: "finalized",
    confidence: (Number(score.confidenceScore) / 100).toFixed(4),
    policyKey: SCORE_POLICY_KEY,
    policyVersion: score.scoreVersion,
    featureSnapshotId: null,
    result: {
      opportunity: Number(score.opportunityScore),
      risk: Number(score.riskScore),
      confidence: Number(score.confidenceScore),
      liquidity: Number(score.liquidityScore),
      recommendation: score.recommendation,
      score_snapshot_id: score.id,
      feature_snapshot_id: score.featureSnapshotId,
      explanations: score.explanations,
      uncalibrated: score.uncalibrated === "true",
    },
  });
  return getDecisionRecord(db, { organizationId: input.organizationId, id: decisionId });
}

export async function scoreAndPersist(
  db: Database,
  input: { printingId: string; asOf: Date; scoreVersion?: string },
) {
  const scored = await scorePrinting(db, input);
  return persistScoreSnapshot(db, scored);
}
