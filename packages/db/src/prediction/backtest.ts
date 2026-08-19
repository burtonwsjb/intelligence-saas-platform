import type { Database } from "../client.js";
import { tcgBacktestRun } from "../schema/prediction.js";
import { BACKTEST_VERSION, PREDICTION_MODEL_VERSION, type PredictionHorizon } from "./catalog.js";
import { issuePrediction } from "./issue.js";
import { evaluatePrediction, isPendingPredictionEvaluation } from "./evaluate.js";
import {
  calibrationBuckets,
  directionAccuracy,
  meanAbsError,
  rangeCoverage,
  rootMeanSquare,
} from "./metrics.js";
import { getModel } from "./model.js";

export async function walkForwardBacktest(
  db: Database,
  input: {
    printingId: string;
    horizon: PredictionHorizon;
    asOfDates: Date[];
    evaluationAsOf: Date;
    modelVersion?: string;
    calibrationWindowEnd?: Date;
  },
) {
  const model = getModel(input.modelVersion);
  const evaluationDates = input.asOfDates.filter((date) =>
    input.calibrationWindowEnd ? date.getTime() > input.calibrationWindowEnd.getTime() : true,
  );
  const outcomes = [];
  for (const issuedAt of evaluationDates) {
    const prediction = await issuePrediction(db, {
      printingId: input.printingId,
      horizon: input.horizon,
      issuedAt,
      dataCutoffAt: issuedAt,
      modelVersion: model.version,
    });
    const outcome = await evaluatePrediction(db, prediction.id, input.evaluationAsOf);
    if (isPendingPredictionEvaluation(outcome)) {
      continue;
    }
    outcomes.push({ prediction, outcome });
  }
  const evaluated = outcomes.filter((row) => row.outcome.dataQuality === "complete");
  const metrics = {
    n: evaluated.length,
    direction_accuracy: directionAccuracy(
      evaluated.map((row) => ({
        predictedUp: Number(row.prediction.probabilityIncrease ?? 0.5) >= 0.5,
        actualUp: Number(row.outcome.actualReturn) > 0,
      })),
    ),
    mae: meanAbsError(evaluated.map((row) => Number(row.outcome.forecastError)).filter(Number.isFinite)),
    rmse: rootMeanSquare(evaluated.map((row) => Number(row.outcome.forecastError)).filter(Number.isFinite)),
    range_coverage: rangeCoverage(evaluated.map((row) => row.outcome.rangeHit === "hit")),
    mean_brier:
      evaluated.length === 0
        ? null
        : evaluated.reduce((sum, row) => sum + Number(row.outcome.brierScore ?? 0), 0) / evaluated.length,
    calibration: calibrationBuckets(
      evaluated
        .filter((row) => row.prediction.probabilityIncrease != null)
        .map((row) => ({
          p: Number(row.prediction.probabilityIncrease),
          y: (Number(row.outcome.actualReturn) > 0 ? 1 : 0) as 0 | 1,
        })),
    ),
    walk_forward: true,
    look_ahead: false,
  };
  const [run] = await db
    .insert(tcgBacktestRun)
    .values({
      id: crypto.randomUUID(),
      modelVersion: model.version,
      methodVersion: BACKTEST_VERSION,
      calibrationWindowEnd: input.calibrationWindowEnd ?? null,
      evaluationWindowStart: evaluationDates[0] ?? input.asOfDates[0]!,
      evaluationWindowEnd: input.evaluationAsOf,
      metrics,
    })
    .returning();
  return { run: run!, outcomes, metrics, modelVersion: PREDICTION_MODEL_VERSION };
}
