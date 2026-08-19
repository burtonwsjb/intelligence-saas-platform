import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { creatorCall, creatorCallOutcome } from "../schema/creator.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgPrinting, tcgSet } from "../schema/tcg.js";

export const OUTCOME_VERSION = "outcome.v1";
export const EARLY_CALL_VERSION = "early_call.v1";

const HORIZON_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

export function horizonDays(code: string, customDays: string | null): number | null {
  if (code === "custom") {
    const n = customDays == null ? null : Number(customDays);
    return n && Number.isFinite(n) && n > 0 ? n : null;
  }
  return HORIZON_DAYS[code] ?? null;
}

async function soldInWindow(
  db: Database,
  input: { printingId: string; from: Date; to: Date; nmOnly?: boolean },
) {
  const clauses = [
    eq(tcgMarketSnapshot.printingId, input.printingId),
    eq(tcgMarketSnapshot.priceType, "sold"),
    gt(tcgMarketSnapshot.observedAt, input.from),
    lte(tcgMarketSnapshot.observedAt, input.to),
  ];
  if (input.nmOnly) {
    clauses.push(eq(tcgMarketSnapshot.condition, "nm"));
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
  const days = horizonDays(call.horizonCode, call.horizonCustomDays);
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
  const end = Number(endRow.price);
  const ret = (end - start) / start;
  const path = usable.map((row) => (Number(row.price) - start) / start);
  const mfe = path.length ? Math.max(...path, 0) : 0;
  const mae = path.length ? Math.min(...path, 0) : 0;
  let directional: string = "flat";
  if (call.direction === "bullish") {
    directional = ret > 0.005 ? "correct" : ret < -0.005 ? "incorrect" : "flat";
  } else if (call.direction === "bearish") {
    directional = ret < -0.005 ? "correct" : ret > 0.005 ? "incorrect" : "flat";
  } else {
    directional = "not_applicable";
  }
  let targetHit: string | null = null;
  if (call.targetPrice != null) {
    const target = Number(call.targetPrice);
    targetHit =
      call.direction === "bearish" ? (end <= target ? "hit" : "miss") : end >= target ? "hit" : "miss";
  } else if (call.targetPercent != null) {
    const target = Number(call.targetPercent) / 100;
    targetHit =
      call.direction === "bearish" ? (ret <= -target ? "hit" : "miss") : ret >= target ? "hit" : "miss";
  }
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
      dataQuality: "complete",
      evaluatedAt: asOf,
      methodVersion: OUTCOME_VERSION,
    })
    .where(eq(creatorCallOutcome.id, outcome.id));
  return getOutcome(db, callId);
}

export async function getOutcome(db: Database, callId: string) {
  const [row] = await db.select().from(creatorCallOutcome).where(eq(creatorCallOutcome.callId, callId)).limit(1);
  return row ?? null;
}

export async function earlyCallScore(
  db: Database,
  input: { printingId: string; publishedAt: Date; startPrice: number; horizonReturn: number },
) {
  const preFrom = new Date(input.publishedAt.getTime() - 7 * 86400000);
  const pre = await soldInWindow(db, {
    printingId: input.printingId,
    from: preFrom,
    to: input.publishedAt,
    nmOnly: true,
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
