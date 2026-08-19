import { and, asc, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgPrediction, tcgPredictionOutcome } from "../schema/prediction.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { getIndexLevelAsOf, indexReturn } from "../analytics/index-engine.js";
import { printingBenchmarkContext, resolveBenchmark } from "../analytics/benchmark.js";
import { CALIBRATION_VERSION, PREDICTION_HORIZON_DAYS, type PredictionHorizon } from "./catalog.js";
import { brierScore } from "./metrics.js";
import { MS_DAY } from "../analytics/catalog.js";

export type PendingPredictionEvaluation = {
  status: "horizon_not_elapsed";
  predictionId: string;
  horizonEndsAt: Date;
};

export function isPendingPredictionEvaluation(
  value: PendingPredictionEvaluation | typeof tcgPredictionOutcome.$inferSelect,
): value is PendingPredictionEvaluation {
  return "status" in value && value.status === "horizon_not_elapsed";
}

export async function evaluatePrediction(db: Database, predictionId: string, asOf: Date) {
  const [existing] = await db
    .select()
    .from(tcgPredictionOutcome)
    .where(eq(tcgPredictionOutcome.predictionId, predictionId))
    .limit(1);
  if (existing) {
    return existing;
  }
  const [prediction] = await db.select().from(tcgPrediction).where(eq(tcgPrediction.id, predictionId)).limit(1);
  if (!prediction) {
    throw new Error("prediction not found.");
  }
  const days = PREDICTION_HORIZON_DAYS[prediction.horizon as PredictionHorizon];
  const endAt = new Date(prediction.issuedAt.getTime() + days * MS_DAY);
  if (asOf.getTime() < endAt.getTime()) {
    return {
      status: "horizon_not_elapsed" as const,
      predictionId,
      horizonEndsAt: endAt,
    };
  }
  const sold = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, prediction.printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, "nm"),
        isNull(tcgMarketSnapshot.gradingCompany),
        eq(tcgMarketSnapshot.outlierFlag, false),
        isNotNull(tcgMarketSnapshot.price),
        gt(tcgMarketSnapshot.observedAt, prediction.issuedAt),
        lte(tcgMarketSnapshot.observedAt, endAt),
      ),
    )
    .orderBy(asc(tcgMarketSnapshot.observedAt));
  const end = sold.filter((row) => row.price != null).at(-1);
  if (!end?.price || prediction.priceAtIssue == null) {
    const [row] = await db
      .insert(tcgPredictionOutcome)
      .values({
        id: crypto.randomUUID(),
        predictionId,
        evaluatedAt: asOf,
        calibrationVersion: CALIBRATION_VERSION,
        dataQuality: "insufficient_data",
        components: { look_ahead: false, sold_in_horizon: sold.length },
      })
      .returning();
    return row!;
  }
  const start = Number(prediction.priceAtIssue);
  const actualPrice = Number(end.price);
  const actualReturn = (actualPrice - start) / start;
  const expected = prediction.expectedReturn == null ? null : Number(prediction.expectedReturn);
  const pUp = prediction.probabilityIncrease == null ? null : Number(prediction.probabilityIncrease);
  const predictedUp = (pUp ?? 0.5) >= 0.5;
  const actualUp = actualReturn > 0;
  const error = expected == null ? null : actualReturn - expected;
  const low = prediction.returnRangeLow == null ? null : Number(prediction.returnRangeLow);
  const high = prediction.returnRangeHigh == null ? null : Number(prediction.returnRangeHigh);
  const rangeHit = low == null || high == null ? null : actualReturn >= low && actualReturn <= high ? "hit" : "miss";
  const realized: 0 | 1 = actualUp ? 1 : 0;
  const brier = pUp == null ? null : brierScore(pUp, realized);
  const path = sold.map((row) => (Number(row.price) - start) / start);
  const peak = path.length ? Math.max(...path, 0) : 0;
  const trough = path.length ? Math.min(...path, 0) : 0;
  const drawdown = peak > 0 ? (peak - (path.at(-1) ?? 0)) / (1 + peak) : Math.abs(Math.min(trough, 0));

  let bench: number | null = null;
  const ctx = await printingBenchmarkContext(db, prediction.printingId);
  if (ctx) {
    const resolved = await resolveBenchmark(db, {
      gameKey: ctx.gameKey,
      languageCode: ctx.languageCode,
      setKey: ctx.setKey,
      asOf: prediction.issuedAt,
    });
    if (resolved.status === "ok" && resolved.indexKey) {
      const startLevel = await getIndexLevelAsOf(db, resolved.indexKey, prediction.issuedAt);
      const endLevel = await getIndexLevelAsOf(db, resolved.indexKey, endAt);
      if (startLevel && endLevel) {
        const value = indexReturn(Number(startLevel.indexValue), Number(endLevel.indexValue));
        bench = Number.isFinite(value) ? value : null;
      }
    }
  }

  const [row] = await db
    .insert(tcgPredictionOutcome)
    .values({
      id: crypto.randomUUID(),
      predictionId,
      evaluatedAt: asOf,
      actualPrice: actualPrice.toFixed(8),
      actualReturn: actualReturn.toFixed(6),
      directionalAccuracy: predictedUp === actualUp ? "correct" : "incorrect",
      forecastError: error == null ? null : error.toFixed(6),
      absError: error == null ? null : Math.abs(error).toFixed(6),
      rangeHit,
      brierScore: brier == null ? null : brier.toFixed(6),
      benchmarkReturn: bench == null ? null : bench.toFixed(6),
      alpha: bench == null ? null : (actualReturn - bench).toFixed(6),
      drawdown: drawdown.toFixed(6),
      calibrationVersion: CALIBRATION_VERSION,
      dataQuality: "complete",
      components: {
        look_ahead: false,
        future_after_horizon_ignored: true,
        sold_in_horizon: sold.length,
        calibration: CALIBRATION_VERSION,
      },
    })
    .returning();
  return row!;
}
