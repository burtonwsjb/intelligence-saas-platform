import { desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgPrediction } from "../schema/prediction.js";
import { insertBreakGlassAudit } from "./audit.js";

/**
 * Internal/admin preview of shadow predictions. Never used by customer UI.
 */
export async function listPredictionsForOperator(db: Database, actorUserId: string, limit = 50) {
  await insertBreakGlassAudit(db, {
    actorUserId,
    action: "predictions.preview",
    targetType: "tcg_prediction",
  });
  return db
    .select({
      id: tcgPrediction.id,
      printingId: tcgPrediction.printingId,
      issuedAt: tcgPrediction.issuedAt,
      horizon: tcgPrediction.horizon,
      modelVersion: tcgPrediction.modelVersion,
      visibility: tcgPrediction.visibility,
      status: tcgPrediction.status,
      languageCode: tcgPrediction.languageCode,
      expectedReturn: tcgPrediction.expectedReturn,
      confidence: tcgPrediction.confidence,
      dataQuality: tcgPrediction.dataQuality,
    })
    .from(tcgPrediction)
    .orderBy(desc(tcgPrediction.issuedAt))
    .limit(Math.min(limit, 200));
}
