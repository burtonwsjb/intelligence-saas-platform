import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { creatorCall, creatorCallOutcome } from "../schema/creator.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgPrinting, tcgSet } from "../schema/tcg.js";
import { assetPriceAt, assetPricesBetween } from "./assets.js";
import { callGradeFromEvidence, type CallGrade } from "./grade.js";

export const OUTCOME_VERSION = "outcome.v1";
export const EARLY_CALL_VERSION = "early_call.v1";

const HORIZON_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

/** An asset call waits this long past its horizon for a closing price before it is marked insufficient. */
export const ASSET_CLOSE_GRACE_DAYS = 7;
/** The closing price must be observed within this many days before the horizon end. */
export const ASSET_CLOSE_MAX_AGE_DAYS = 7;

/**
 * Calls that name no horizon ("this set will go up") are judged over this many
 * days, roughly the "next few months" most such calls mean. The outcome's
 * data_quality records that the default was used.
 */
export const DEFAULT_EVALUATION_DAYS = 90;

export function horizonDays(code: string, customDays: string | null): number | null {
  if (code === "custom") {
    const n = customDays == null ? null : Number(customDays);
    return n && Number.isFinite(n) && n > 0 ? n : null;
  }
  return HORIZON_DAYS[code] ?? null;
}

async function soldInWindow(
  db: Database,
  input: { printingId: string; from: Date; to: Date; nmOnly?: boolean; grade?: CallGrade | null },
) {
  const clauses = [
    eq(tcgMarketSnapshot.printingId, input.printingId),
    eq(tcgMarketSnapshot.priceType, "sold"),
    gt(tcgMarketSnapshot.observedAt, input.from),
    lte(tcgMarketSnapshot.observedAt, input.to),
  ];
  if (input.grade) {
    // A graded call is judged only on sales of that exact grade.
    clauses.push(eq(tcgMarketSnapshot.gradingCompany, input.grade.company));
    clauses.push(eq(tcgMarketSnapshot.gradeNumeric, input.grade.grade.toFixed(2)));
    clauses.push(eq(tcgMarketSnapshot.outlierFlag, false));
  } else {
    // Raw calls never read graded sales, which are a different market.
    clauses.push(isNull(tcgMarketSnapshot.gradingCompany));
    if (input.nmOnly) clauses.push(eq(tcgMarketSnapshot.condition, "nm"));
  }
  return db
    .select()
    .from(tcgMarketSnapshot)
    .where(and(...clauses))
    .orderBy(asc(tcgMarketSnapshot.observedAt));
}

export async function evaluateCreatorCallOutcome(
  db: Database,
  callId: string,
  asOf: Date,
) {
  const [call] = await db.select().from(creatorCall).where(eq(creatorCall.id, callId)).limit(1);
  const [outcome] = await db.select().from(creatorCallOutcome).where(eq(creatorCallOutcome.callId, callId)).limit(1);
  if (!call || !outcome) {
    throw new Error("creator call or outcome not found.");
  }
  const defaultHorizon = call.horizonCode === "unspecified";
  const days = defaultHorizon ? DEFAULT_EVALUATION_DAYS : horizonDays(call.horizonCode, call.horizonCustomDays);
  if (call.assetId) {
    return evaluateAssetCall(db, { call, outcomeId: outcome.id, days, defaultHorizon, asOf });
  }
  if (!call.printingId || call.priceAtCall == null || days == null) {
    await db
      .update(creatorCallOutcome)
      .set({
        evaluationStatus: "insufficient_data",
        dataQuality: "missing_identity_price_or_horizon",
        methodVersion: OUTCOME_VERSION,
        evaluatedAt: asOf,
      })
      .where(eq(creatorCallOutcome.id, outcome.id));
    return getOutcome(db, callId);
  }
  if (!["exact", "high_confidence"].includes(call.resolutionStatus)) {
    await db
      .update(creatorCallOutcome)
      .set({
        evaluationStatus: "insufficient_data",
        dataQuality: "unresolved_printing",
        methodVersion: OUTCOME_VERSION,
        evaluatedAt: asOf,
      })
      .where(eq(creatorCallOutcome.id, outcome.id));
    return getOutcome(db, callId);
  }
  const start = Number(call.priceAtCall);
  const endAt = new Date(call.publishedAt.getTime() + days * 86400000);
  if (asOf.getTime() < endAt.getTime()) {
    await db
      .update(creatorCallOutcome)
      .set({ evaluationStatus: "pending", dataQuality: "horizon_not_elapsed", methodVersion: OUTCOME_VERSION })
      .where(eq(creatorCallOutcome.id, outcome.id));
    return getOutcome(db, callId);
  }
  const windowSold = await soldInWindow(db, {
    printingId: call.printingId,
    from: call.publishedAt,
    to: endAt,
    nmOnly: true,
    grade: callGradeFromEvidence(call.evidence),
  });
  const usable = windowSold.filter((row) => row.observedAt.getTime() <= endAt.getTime());
  const endRow = usable.at(-1);
  if (!endRow?.price) {
    await db
      .update(creatorCallOutcome)
      .set({
        evaluationStatus: "insufficient_data",
        startingPrice: call.priceAtCall,
        dataQuality: "missing_market_data",
        methodVersion: OUTCOME_VERSION,
        evaluatedAt: asOf,
      })
      .where(eq(creatorCallOutcome.id, outcome.id));
    return getOutcome(db, callId);
  }
  const { ret, mfe, mae, directional, targetHit } = grade({
    direction: call.direction,
    start,
    end: Number(endRow.price),
    path: usable.map((row) => Number(row.price)),
    targetPrice: call.targetPrice,
    targetPercent: call.targetPercent,
  });
  await db
    .update(creatorCallOutcome)
    .set({
      evaluationStatus: "evaluated",
      startingPrice: call.priceAtCall,
      endingPrice: endRow.price,
      returnPct: ret.toFixed(6),
      directionalCorrect: directional,
      targetHit,
      maxFavorableExcursion: mfe.toFixed(6),
      maxAdverseExcursion: mae.toFixed(6),
      dataQuality: defaultHorizon ? "complete_default_horizon" : "complete",
      evaluatedAt: asOf,
      methodVersion: OUTCOME_VERSION,
    })
    .where(eq(creatorCallOutcome.id, outcome.id));
  return getOutcome(db, callId);
}

function grade(input: {
  direction: string;
  start: number;
  end: number;
  path: number[];
  targetPrice: string | null;
  targetPercent: string | null;
}) {
  const ret = (input.end - input.start) / input.start;
  const path = input.path.map((price) => (price - input.start) / input.start);
  const mfe = path.length ? Math.max(...path, 0) : 0;
  const mae = path.length ? Math.min(...path, 0) : 0;
  let directional = "not_applicable";
  if (input.direction === "bullish") {
    directional = ret > 0.005 ? "correct" : ret < -0.005 ? "incorrect" : "flat";
  } else if (input.direction === "bearish") {
    directional = ret < -0.005 ? "correct" : ret > 0.005 ? "incorrect" : "flat";
  }
  let targetHit: string | null = null;
  if (input.targetPrice != null) {
    const target = Number(input.targetPrice);
    targetHit = input.direction === "bearish" ? (input.end <= target ? "hit" : "miss") : input.end >= target ? "hit" : "miss";
  } else if (input.targetPercent != null) {
    const target = Number(input.targetPercent) / 100;
    targetHit = input.direction === "bearish" ? (ret <= -target ? "hit" : "miss") : ret >= target ? "hit" : "miss";
  }
  return { ret, mfe, mae, directional, targetHit };
}

/**
 * Asset calls are graded on the asset's price series. The starting price is
 * the call's price at call, or failing that the newest price no later than the
 * post (from a backfill), so a call made before the feed ran can still be
 * scored. Only prices inside the call window are read.
 */
async function evaluateAssetCall(
  db: Database,
  input: {
    call: typeof creatorCall.$inferSelect;
    outcomeId: string;
    days: number | null;
    defaultHorizon: boolean;
    asOf: Date;
  },
) {
  const { call, asOf } = input;
  const finish = async (values: Partial<typeof creatorCallOutcome.$inferInsert>) => {
    await db
      .update(creatorCallOutcome)
      .set({ methodVersion: OUTCOME_VERSION, ...values })
      .where(eq(creatorCallOutcome.id, input.outcomeId));
    return getOutcome(db, call.id);
  };
  if (input.days == null) {
    return finish({ evaluationStatus: "insufficient_data", dataQuality: "missing_horizon", evaluatedAt: asOf });
  }
  const endAt = new Date(call.publishedAt.getTime() + input.days * 86_400_000);
  if (asOf.getTime() < endAt.getTime()) {
    return finish({ evaluationStatus: "pending", dataQuality: "horizon_not_elapsed" });
  }
  const startRow = call.priceAtCall == null ? await assetPriceAt(db, { assetId: call.assetId!, at: call.publishedAt }) : null;
  const startPrice = call.priceAtCall ?? startRow?.price ?? null;
  const window = await assetPricesBetween(db, { assetId: call.assetId!, from: call.publishedAt, to: endAt });
  const endRow = window.at(-1);
  const closeFresh = endRow && endRow.observedAt.getTime() >= endAt.getTime() - ASSET_CLOSE_MAX_AGE_DAYS * 86_400_000;
  if (startPrice == null || !closeFresh) {
    const waiting = asOf.getTime() < endAt.getTime() + ASSET_CLOSE_GRACE_DAYS * 86_400_000;
    return finish(
      waiting
        ? { evaluationStatus: "pending", dataQuality: "awaiting_market_data" }
        : {
            evaluationStatus: "insufficient_data",
            startingPrice: startPrice,
            dataQuality: startPrice == null ? "missing_price_at_call" : "missing_market_data",
            evaluatedAt: asOf,
          },
    );
  }
  const start = Number(startPrice);
  const end = Number(endRow!.price);
  const graded = grade({
    direction: call.direction,
    start,
    end,
    path: window.map((row) => Number(row.price)),
    targetPrice: call.targetPrice,
    targetPercent: call.targetPercent,
  });
  return finish({
    evaluationStatus: "evaluated",
    startingPrice: startPrice,
    endingPrice: endRow!.price,
    returnPct: graded.ret.toFixed(6),
    directionalCorrect: graded.directional,
    targetHit: graded.targetHit,
    maxFavorableExcursion: graded.mfe.toFixed(6),
    maxAdverseExcursion: graded.mae.toFixed(6),
    dataQuality: input.defaultHorizon ? "complete_default_horizon" : "complete",
    evaluatedAt: asOf,
  });
}

export async function getOutcome(db: Database, callId: string) {
  const [row] = await db.select().from(creatorCallOutcome).where(eq(creatorCallOutcome.callId, callId)).limit(1);
  return row ?? null;
}

export async function earlyCallScore(
  db: Database,
  input: { printingId: string; publishedAt: Date; startPrice: number; horizonReturn: number; grade?: CallGrade | null },
) {
  const preFrom = new Date(input.publishedAt.getTime() - 7 * 86400000);
  const pre = await soldInWindow(db, {
    printingId: input.printingId,
    from: preFrom,
    to: input.publishedAt,
    nmOnly: true,
    grade: input.grade,
  });
  const first = pre[0];
  if (!first?.price) {
    return { score: null, version: EARLY_CALL_VERSION, preMove: null };
  }
  const preMove = (input.startPrice - Number(first.price)) / Number(first.price);
  const score = input.horizonReturn - preMove;
  return { score, version: EARLY_CALL_VERSION, preMove };
}

export async function printingContext(db: Database, printingId: string) {
  const [row] = await db
    .select({
      gameKey: tcgPrinting.gameKey,
      languageCode: tcgPrinting.languageCode,
      setKey: tcgSet.canonicalSetKey,
    })
    .from(tcgPrinting)
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .where(eq(tcgPrinting.id, printingId))
    .limit(1);
  return row ?? null;
}
