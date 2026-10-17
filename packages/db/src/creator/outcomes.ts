import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { creatorCall, creatorCallOutcome } from "../schema/creator.js";
import { marketAsset } from "../schema/asset.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { tcgPrinting, tcgSet } from "../schema/tcg.js";
import { assetPriceAt, assetPricesBetween } from "./assets.js";
import { callGradeFromEvidence, type CallGrade } from "./grade.js";

export const OUTCOME_VERSION = "outcome.v2";

/**
 * A move within this share of the starting price either way is "flat": the
 * price stagnated. Card prices wander a little day to day, so a call that said
 * up or down needs a real move to count as right. A flat result counts
 * against the call (see creator/authority.ts).
 */
export const FLAT_BAND = 0.02;

/** A set call is scored only when at least this many of the set's cards have a price at both ends. */
export const SET_BASKET_MIN_PRINTINGS = 3;
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
export const DEFAULT_EVALUATION_DAYS = 30;

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

/** A post without an earlier price may start from one seen at most this long after it. */
export const START_PRICE_GRACE_MS = 2 * 86_400_000;
/** A market-price close must be observed within this long before the deadline. */
const CLOSE_MAX_AGE_MS = 7 * 86_400_000;

/** Raw (ungraded) prices of one printing in a window, oldest first. */
async function rawPricesInWindow(
  db: Database,
  input: { printingId: string; from: Date; to: Date; priceType?: "sold" | "reference" },
) {
  return db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        input.priceType
          ? eq(tcgMarketSnapshot.priceType, input.priceType)
          : inArray(tcgMarketSnapshot.priceType, ["sold", "reference"]),
        isNull(tcgMarketSnapshot.gradingCompany),
        eq(tcgMarketSnapshot.outlierFlag, false),
        gt(tcgMarketSnapshot.observedAt, input.from),
        lte(tcgMarketSnapshot.observedAt, input.to),
      ),
    )
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
  if (!call.printingId || days == null) {
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
  const endAt = new Date(call.publishedAt.getTime() + days * 86400000);
  if (asOf.getTime() < endAt.getTime()) {
    await db
      .update(creatorCallOutcome)
      .set({ evaluationStatus: "pending", dataQuality: "horizon_not_elapsed", methodVersion: OUTCOME_VERSION })
      .where(eq(creatorCallOutcome.id, outcome.id));
    return getOutcome(db, callId);
  }
  const callGrade = callGradeFromEvidence(call.evidence);
  // Without a price from before the post, a raw card call may start from the
  // first price seen shortly after it; the data quality records that it did.
  let startingPrice = call.priceAtCall;
  let startAfterCall = false;
  if (startingPrice == null && !callGrade) {
    const [first] = await rawPricesInWindow(db, {
      printingId: call.printingId,
      from: call.publishedAt,
      to: new Date(Math.min(call.publishedAt.getTime() + START_PRICE_GRACE_MS, endAt.getTime())),
    });
    if (first?.price) {
      startingPrice = first.price;
      startAfterCall = true;
    }
  }
  if (startingPrice == null) {
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
  const start = Number(startingPrice);
  const windowSold = await soldInWindow(db, {
    printingId: call.printingId,
    from: call.publishedAt,
    to: endAt,
    nmOnly: true,
    grade: callGrade,
  });
  let usable = windowSold.filter((row) => row.observedAt.getTime() <= endAt.getTime());
  // Raw cards without sales in the window are judged on the daily market price
  // (TCGplayer's market price is itself built from recent sales). Graded calls
  // need sales of their grade.
  let referencePrice = false;
  if (usable.length === 0 && !callGrade) {
    usable = await rawPricesInWindow(db, { printingId: call.printingId, from: call.publishedAt, to: endAt, priceType: "reference" });
    referencePrice = usable.length > 0;
  }
  const endRow = usable.at(-1);
  // The closing price must be near the deadline, not left over from the start of the window.
  const closeTooEarly = endRow ? endAt.getTime() - endRow.observedAt.getTime() > CLOSE_MAX_AGE_MS : true;
  if (!endRow?.price || (referencePrice && closeTooEarly)) {
    await db
      .update(creatorCallOutcome)
      .set({
        evaluationStatus: "insufficient_data",
        startingPrice,
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
      startingPrice,
      endingPrice: endRow.price,
      returnPct: ret.toFixed(6),
      directionalCorrect: directional,
      targetHit,
      maxFavorableExcursion: mfe.toFixed(6),
      maxAdverseExcursion: mae.toFixed(6),
      dataQuality: [
        defaultHorizon ? "complete_default_horizon" : "complete",
        referencePrice ? "market_price" : null,
        startAfterCall ? "start_after_call" : null,
      ]
        .filter(Boolean)
        .join("+"),
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
    directional = ret > FLAT_BAND ? "correct" : ret < -FLAT_BAND ? "incorrect" : "flat";
  } else if (input.direction === "bearish") {
    directional = ret < -FLAT_BAND ? "correct" : ret > FLAT_BAND ? "incorrect" : "flat";
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
  const [asset] = await db
    .select({ kind: marketAsset.kind, setId: marketAsset.setId })
    .from(marketAsset)
    .where(eq(marketAsset.id, call.assetId!))
    .limit(1);
  if (asset?.kind === "set" && asset.setId) {
    const basket = await setBasketMove(db, { setId: asset.setId, from: call.publishedAt, to: endAt });
    if (!basket) {
      const waiting = asOf.getTime() < endAt.getTime() + ASSET_CLOSE_GRACE_DAYS * 86_400_000;
      return finish(
        waiting
          ? { evaluationStatus: "pending", dataQuality: "awaiting_market_data" }
          : { evaluationStatus: "insufficient_data", dataQuality: "missing_market_data", evaluatedAt: asOf },
      );
    }
    // A set has no single price, so the starting and ending prices stay empty.
    const graded = grade({
      direction: call.direction,
      start: 1,
      end: 1 + basket.ret,
      path: basket.path.map((move) => 1 + move),
      targetPrice: null,
      targetPercent: call.targetPercent,
    });
    return finish({
      evaluationStatus: "evaluated",
      returnPct: graded.ret.toFixed(6),
      directionalCorrect: graded.directional,
      targetHit: graded.targetHit,
      maxFavorableExcursion: graded.mfe.toFixed(6),
      maxAdverseExcursion: graded.mae.toFixed(6),
      dataQuality: [
        input.defaultHorizon ? "complete_default_horizon" : "complete",
        `set_card_median_n${basket.printings}`,
        basket.startAfterCall ? "start_after_call" : null,
      ]
        .filter(Boolean)
        .join("+"),
      evaluatedAt: asOf,
    });
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

/**
 * How a set's cards moved between `from` and `to`: the median of each card's
 * own move, over the set's raw cards with a USD market price at both ends. A
 * card's start is its newest price in the 2 days up to `from` (or, failing
 * that, its first in the 2 days after); its close is its newest price in the
 * 7 days up to `to`. Nothing after `to` is read. `path` is the median move on
 * each day in between, for the best and worst point of the call. Null when
 * fewer than SET_BASKET_MIN_PRINTINGS cards qualify.
 */
export async function setBasketMove(db: Database, input: { setId: string; from: Date; to: Date }) {
  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();
  const rows = (await db.execute(sql`
    WITH r AS (
      SELECT m.printing_id, m.observed_at, m.price::double precision AS price
      FROM tcg_market_snapshot m
      JOIN tcg_printing p ON p.id = m.printing_id
      WHERE p.set_id = ${input.setId}
        AND m.price_type = 'reference'
        AND m.grading_company IS NULL
        AND m.outlier_flag = false
        AND m.currency = 'USD'
        AND m.price > 0
        AND m.observed_at > ${fromIso}::timestamptz - interval '2 days'
        AND m.observed_at <= ${toIso}::timestamptz
    ),
    before_post AS (
      SELECT DISTINCT ON (printing_id) printing_id, price, false AS after_call
      FROM r WHERE observed_at <= ${fromIso}::timestamptz
      ORDER BY printing_id, observed_at DESC
    ),
    after_post AS (
      SELECT DISTINCT ON (printing_id) printing_id, price, true AS after_call
      FROM r
      WHERE observed_at > ${fromIso}::timestamptz
        AND observed_at <= least(${fromIso}::timestamptz + interval '2 days', ${toIso}::timestamptz)
        AND printing_id NOT IN (SELECT printing_id FROM before_post)
      ORDER BY printing_id, observed_at ASC
    ),
    s AS (SELECT * FROM before_post UNION ALL SELECT * FROM after_post),
    c AS (
      SELECT DISTINCT ON (printing_id) printing_id, price
      FROM r WHERE observed_at >= ${toIso}::timestamptz - interval '7 days'
      ORDER BY printing_id, observed_at DESC
    ),
    basket AS (
      SELECT s.printing_id, s.price AS start, c.price AS close, s.after_call FROM s JOIN c USING (printing_id)
    ),
    days AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price / b.start - 1) AS move
      FROM r JOIN basket b USING (printing_id)
      WHERE r.observed_at > ${fromIso}::timestamptz
      GROUP BY date_trunc('day', r.observed_at)
      ORDER BY date_trunc('day', r.observed_at)
    )
    SELECT
      (SELECT count(*)::int FROM basket) AS printings,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY close / start - 1) FROM basket) AS ret,
      (SELECT bool_or(after_call) FROM basket) AS start_after_call,
      (SELECT coalesce(array_agg(move), '{}') FROM days) AS path
  `)) as unknown;
  const row = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)[0] as
    | { printings: number; ret: number | string | null; start_after_call: boolean | null; path: (number | string)[] | null }
    | undefined;
  if (!row || Number(row.printings) < SET_BASKET_MIN_PRINTINGS || row.ret == null) return null;
  return {
    printings: Number(row.printings),
    ret: Number(row.ret),
    path: (row.path ?? []).map(Number),
    startAfterCall: row.start_after_call === true,
  };
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
