import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgPrediction } from "../schema/prediction.js";
import { computeMarketFeatures, persistMarketFeatureSnapshot } from "../analytics/features.js";
import { tcgPrinting } from "../schema/tcg.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { DEFAULT_PREDICTION_VISIBILITY, PREDICTION_MODEL_VERSION, type PredictionHorizon } from "./catalog.js";
import { getModel, type FrozenFeatures } from "./model.js";

export async function freezeFeatures(db: Database, printingId: string, cutoff: Date): Promise<FrozenFeatures> {
  const [printing] = await db
    .select({ languageCode: tcgPrinting.languageCode })
    .from(tcgPrinting)
    .where(eq(tcgPrinting.id, printingId))
    .limit(1);
  if (!printing) {
    throw new Error("printing not found.");
  }
  const computed = await computeMarketFeatures(db, { printingId, asOf: cutoff });
  const snapshot = await persistMarketFeatureSnapshot(db, computed);
  const [latest] = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, "nm"),
        isNull(tcgMarketSnapshot.gradingCompany),
        eq(tcgMarketSnapshot.outlierFlag, false),
        isNotNull(tcgMarketSnapshot.price),
        lte(tcgMarketSnapshot.observedAt, cutoff),
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  const returns = computed.features.returns as Record<string, { status: string; value: number | null }>;
  const vol = computed.features.volatility as { status: string; value: number | null };
  return {
    printingId,
    languageCode: printing.languageCode,
    asOf: cutoff,
    priceAtIssue: latest?.price == null ? null : Number(latest.price),
    sampleSize: computed.sampleSize,
    dataQuality: computed.dataQuality,
    return7d: returns["7d"]?.status === "ok" ? returns["7d"].value : null,
    return30d: returns["30d"]?.status === "ok" ? returns["30d"].value : null,
    volatility: vol?.status === "ok" ? vol.value : null,
    featureSnapshotId: snapshot.id,
    featureSetVersion: String(computed.features.feature_set_version ?? ""),
  };
}

export async function issuePrediction(
  db: Database,
  input: {
    printingId: string;
    horizon: PredictionHorizon;
    issuedAt: Date;
    dataCutoffAt?: Date;
    modelVersion?: string;
    visibility?: string;
  },
) {
  const cutoff = input.dataCutoffAt ?? input.issuedAt;
  if (cutoff.getTime() > input.issuedAt.getTime()) {
    throw new Error("data cutoff cannot be after issued_at.");
  }
  const model = getModel(input.modelVersion);
  const [existing] = await db
    .select()
    .from(tcgPrediction)
    .where(
      and(
        eq(tcgPrediction.printingId, input.printingId),
        eq(tcgPrediction.issuedAt, input.issuedAt),
        eq(tcgPrediction.horizon, input.horizon),
        eq(tcgPrediction.modelVersion, model.version),
      ),
    )
    .limit(1);
  if (existing) {
    return existing;
  }
  const frozen = await freezeFeatures(db, input.printingId, cutoff);
  const forecast = model.predict(frozen, input.horizon);
  const [row] = await db
    .insert(tcgPrediction)
    .values({
      id: crypto.randomUUID(),
      printingId: input.printingId,
      issuedAt: input.issuedAt,
      dataCutoffAt: cutoff,
      horizon: input.horizon,
      modelKey: model.key,
      modelVersion: model.version,
      featureSnapshotId: frozen.featureSnapshotId,
      featureSetVersion: frozen.featureSetVersion,
      visibility: input.visibility ?? DEFAULT_PREDICTION_VISIBILITY,
      status: forecast.dataQuality === "insufficient_data" ? "insufficient_data" : "issued",
      languageCode: frozen.languageCode,
      priceAtIssue: frozen.priceAtIssue == null ? null : frozen.priceAtIssue.toFixed(8),
      expectedReturn: forecast.expectedReturn == null ? null : forecast.expectedReturn.toFixed(6),
      returnRangeLow: forecast.returnRangeLow == null ? null : forecast.returnRangeLow.toFixed(6),
      returnRangeHigh: forecast.returnRangeHigh == null ? null : forecast.returnRangeHigh.toFixed(6),
      priceRangeLow: forecast.priceRangeLow == null ? null : forecast.priceRangeLow.toFixed(8),
      priceRangeHigh: forecast.priceRangeHigh == null ? null : forecast.priceRangeHigh.toFixed(8),
      probabilityIncrease: forecast.probabilityIncrease == null ? null : forecast.probabilityIncrease.toFixed(6),
      probabilityDecline: forecast.probabilityDecline == null ? null : forecast.probabilityDecline.toFixed(6),
      confidence: forecast.confidence.toFixed(4),
      risk: forecast.risk.toFixed(4),
      dataQuality: forecast.dataQuality,
      components: forecast.components,
    })
    .returning();
  return row!;
}

export { PREDICTION_MODEL_VERSION };
