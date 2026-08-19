import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  brierScore,
  evaluatePrediction,
  freezeFeatures,
  ingestTcgMarketRecord,
  isPendingPredictionEvaluation,
  issuePrediction,
  meanAbsPercentError,
  PREDICTION_HORIZONS,
  PREDICTION_MODEL_VERSION,
  readMigrationSql,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  tcgPrediction,
  tcgPredictionOutcome,
  walkForwardBacktest,
  type Database,
  type TcgMarketRecordInput,
} from "../index.js";
import { getModel } from "./model.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const seeded = await seedTcgIdentityFixtures(db);
  for (const record of tcgMarketFixtureRecords()) {
    await ingestTcgMarketRecord(db, record);
  }
  return { db, seeded };
}

function printingRef(language: string, variant = "normal") {
  return {
    game: "pokemon",
    set: "twm",
    collector_number: "214/167",
    language,
    variant,
  };
}

async function sold(
  db: Database,
  input: { id: string; price: number; at: string; language?: string; currency?: string },
) {
  await ingestTcgMarketRecord(db, {
    provider: "fixture",
    provider_record_id: input.id,
    event_type: "tcg.market.sold",
    market_type: "marketplace_sold",
    price_type: "sold",
    observed_at: input.at,
    currency: input.currency ?? (input.language === "ja" ? "JPY" : "USD"),
    condition: "nm",
    price: input.price,
    quantity: 1,
    aggregation_kind: "event",
    printing: printingRef(input.language ?? "en") as TcgMarketRecordInput["printing"],
  });
}

describe("prediction metrics", () => {
  it("computes Brier score and skips MAPE near zero actuals", () => {
    expect(brierScore(0.8, 1)).toBeCloseTo(0.04);
    expect(
      meanAbsPercentError([
        { actual: 0.2, predicted: 0.1 },
        { actual: 40, predicted: 44 },
      ]),
    ).toBeCloseTo(0.1);
  });
});

describe("issued predictions and accountability", () => {
  it("issues 7d/30d/90d/180d/365d shadow forecasts with ranges and frozen features", async () => {
    const { db, seeded } = await setup();
    await sold(db, { id: "hist_dec1", price: 36, at: "2025-12-05T00:00:00.000Z" });
    await sold(db, { id: "hist_dec15", price: 38, at: "2025-12-15T00:00:00.000Z" });
    await sold(db, { id: "hist_dec28", price: 39, at: "2025-12-28T00:00:00.000Z" });
    const issuedAt = new Date("2026-01-04T00:00:00.000Z");
    const rows = [];
    for (const horizon of PREDICTION_HORIZONS) {
      rows.push(
        await issuePrediction(db, {
          printingId: seeded.printings.greninjaEnNormal.id,
          horizon,
          issuedAt,
        }),
      );
    }
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.visibility).toBe("shadow");
      expect(row.modelVersion).toBe(PREDICTION_MODEL_VERSION);
      expect(row.dataCutoffAt.getTime()).toBe(issuedAt.getTime());
      expect(row.languageCode).toBe("en");
      expect(row.probabilityIncrease).not.toBeNull();
      expect(row.returnRangeLow).not.toBeNull();
      expect(row.components).toMatchObject({ opportunity_score_reused: false, look_ahead: false });
    }
  });

  it("does not use future sales in frozen features and rejects a later cutoff", async () => {
    const { db, seeded } = await setup();
    const cutoff = new Date("2026-01-04T00:00:00.000Z");
    const before = await freezeFeatures(db, seeded.printings.greninjaEnNormal.id, cutoff);
    await sold(db, { id: "future_leak", price: 900, at: "2026-01-20T00:00:00.000Z" });
    const after = await freezeFeatures(db, seeded.printings.greninjaEnNormal.id, cutoff);
    expect(after.priceAtIssue).toBe(before.priceAtIssue);
    expect(after.return7d).toBe(before.return7d);
    await expect(
      issuePrediction(db, {
        printingId: seeded.printings.greninjaEnNormal.id,
        horizon: "7d",
        issuedAt: cutoff,
        dataCutoffAt: new Date("2026-01-05T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/cutoff/);
  });

  it("keeps issued rows immutable and retains a bad evaluated forecast", async () => {
    const { db, seeded } = await setup();
    const issuedAt = new Date("2026-01-04T00:00:00.000Z");
    const prediction = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      issuedAt,
    });
    await sold(db, { id: "eval_7d", price: 46, at: "2026-01-10T00:00:00.000Z" });
    const pending = await evaluatePrediction(db, prediction.id, new Date("2026-01-06T00:00:00.000Z"));
    expect(isPendingPredictionEvaluation(pending)).toBe(true);
    const outcome = await evaluatePrediction(db, prediction.id, new Date("2026-01-12T00:00:00.000Z"));
    if (isPendingPredictionEvaluation(outcome)) {
      throw new Error("horizon should have elapsed");
    }
    expect(outcome.dataQuality).toBe("complete");
    expect(Number(outcome.actualPrice)).toBe(46);
    expect(outcome.directionalAccuracy).toMatch(/correct|incorrect/);
    expect(outcome.brierScore).not.toBeNull();
    const replay = await evaluatePrediction(db, prediction.id, new Date("2026-02-01T00:00:00.000Z"));
    if (isPendingPredictionEvaluation(replay)) {
      throw new Error("outcome should be immutable");
    }
    expect(replay.id).toBe(outcome.id);
    await expect(
      db.update(tcgPrediction).set({ visibility: "published" }).where(eq(tcgPrediction.id, prediction.id)),
    ).rejects.toThrow();
    await expect(db.delete(tcgPredictionOutcome).where(eq(tcgPredictionOutcome.id, outcome.id))).rejects.toThrow();
    const [kept] = await db.select().from(tcgPredictionOutcome).where(eq(tcgPredictionOutcome.id, outcome.id));
    expect(kept?.id).toBe(outcome.id);
  });

  it("ignores sales after the horizon when scoring outcomes", async () => {
    const { db, seeded } = await setup();
    const issuedAt = new Date("2026-01-04T00:00:00.000Z");
    const prediction = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "30d",
      issuedAt,
    });
    await sold(db, { id: "in_horizon", price: 45, at: "2026-01-20T00:00:00.000Z" });
    await sold(db, { id: "after_horizon", price: 999, at: "2026-03-01T00:00:00.000Z" });
    const outcome = await evaluatePrediction(db, prediction.id, new Date("2026-03-10T00:00:00.000Z"));
    if (isPendingPredictionEvaluation(outcome)) {
      throw new Error("30d should have elapsed");
    }
    expect(Number(outcome.actualPrice)).toBe(45);
    expect(Number(outcome.actualPrice)).not.toBe(999);
  });

  it("issues a new row when the model version changes and compares baselines", async () => {
    const { db, seeded } = await setup();
    const issuedAt = new Date("2026-01-04T00:00:00.000Z");
    const stats = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      issuedAt,
    });
    const noChange = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      issuedAt,
      modelVersion: "baseline.no_change.v1",
    });
    const momentum = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      issuedAt,
      modelVersion: "baseline.momentum.v1",
    });
    expect(stats.id).not.toBe(noChange.id);
    expect(stats.modelVersion).toBe(PREDICTION_MODEL_VERSION);
    expect(noChange.modelVersion).toBe("baseline.no_change.v1");
    expect(Number(noChange.expectedReturn)).toBe(0);
    expect(momentum.modelVersion).toBe("baseline.momentum.v1");
    expect(getModel().version).toBe(PREDICTION_MODEL_VERSION);
  });

  it("keeps English and Japanese predictions independent", async () => {
    const { db, seeded } = await setup();
    const issuedAt = new Date("2026-01-04T00:00:00.000Z");
    const en = await issuePrediction(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      issuedAt,
    });
    const ja = await issuePrediction(db, {
      printingId: seeded.printings.greninjaJaNormal.id,
      horizon: "7d",
      issuedAt,
    });
    expect(en.languageCode).toBe("en");
    expect(ja.languageCode).toBe("ja");
    expect(en.id).not.toBe(ja.id);
    await sold(db, { id: "ja_eval", price: 9000, at: "2026-01-10T00:00:00.000Z", language: "ja" });
    const jaOutcome = await evaluatePrediction(db, ja.id, new Date("2026-01-12T00:00:00.000Z"));
    if (isPendingPredictionEvaluation(jaOutcome)) {
      throw new Error("ja 7d should have elapsed");
    }
    expect(Number(jaOutcome.actualPrice)).toBe(9000);
  });

  it("marks insufficient data instead of inventing a forecast", async () => {
    const { db, seeded } = await setup();
    const prediction = await issuePrediction(db, {
      printingId: seeded.printings.pikachuSv1.id,
      horizon: "30d",
      issuedAt: new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(prediction.status).toBe("insufficient_data");
    expect(prediction.dataQuality).toBe("insufficient_data");
    expect(prediction.expectedReturn).toBeNull();
  });

  it("walks forward without using the calibration window or future facts", async () => {
    const { db, seeded } = await setup();
    await sold(db, { id: "wf_1", price: 44, at: "2026-01-10T00:00:00.000Z" });
    await sold(db, { id: "wf_2", price: 47, at: "2026-01-18T00:00:00.000Z" });
    const result = await walkForwardBacktest(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      horizon: "7d",
      asOfDates: [
        new Date("2026-01-04T00:00:00.000Z"),
        new Date("2026-01-11T00:00:00.000Z"),
      ],
      calibrationWindowEnd: new Date("2026-01-04T00:00:00.000Z"),
      evaluationAsOf: new Date("2026-01-25T00:00:00.000Z"),
    });
    expect(result.metrics.walk_forward).toBe(true);
    expect(result.metrics.look_ahead).toBe(false);
    expect(result.run.methodVersion).toBe("walk_forward.v1");
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.prediction.issuedAt.toISOString()).toBe("2026-01-11T00:00:00.000Z");
    expect(result.metrics.n).toBe(1);
    expect(result.metrics.direction_accuracy).not.toBeNull();
  });
});
