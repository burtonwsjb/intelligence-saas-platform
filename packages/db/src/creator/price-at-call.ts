import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import type { Database } from "../client.js";
import { CREATOR_PRICE_AT_CALL_VERSION } from "./identity.js";
import type { CallGrade } from "./grade.js";

export type PriceAtCall = {
  price: string;
  currency: string;
  source: string;
  observedAt: Date;
  methodVersion: string;
};

/**
 * The newest sold price for this exact grade at or before the post. Graded
 * copies are a separate market, so raw prices never stand in for them.
 */
export async function gradedPriceAtCall(
  db: Database,
  input: { printingId: string; publishedAt: Date; grade: CallGrade },
): Promise<PriceAtCall | null> {
  const [row] = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.gradingCompany, input.grade.company),
        eq(tcgMarketSnapshot.gradeNumeric, input.grade.grade.toFixed(2)),
        eq(tcgMarketSnapshot.outlierFlag, false),
        lte(tcgMarketSnapshot.observedAt, input.publishedAt),
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  if (!row?.price) return null;
  return {
    price: row.price,
    currency: row.currency,
    source: `${row.sourceKey}:${row.priceType}:${input.grade.company}-${input.grade.grade}`,
    observedAt: row.observedAt,
    methodVersion: CREATOR_PRICE_AT_CALL_VERSION,
  };
}

export async function priceAtCall(
  db: Database,
  input: { printingId: string; publishedAt: Date },
): Promise<PriceAtCall | null> {
  const sold = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        isNull(tcgMarketSnapshot.gradingCompany),
        lte(tcgMarketSnapshot.observedAt, input.publishedAt),
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  const preferNm = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, "nm"),
        isNull(tcgMarketSnapshot.gradingCompany),
        lte(tcgMarketSnapshot.observedAt, input.publishedAt),
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  const row = preferNm[0] ?? sold[0];
  if (row?.price) {
    if (row.observedAt.getTime() > input.publishedAt.getTime()) {
      return null;
    }
    return {
      price: row.price,
      currency: row.currency,
      source: `${row.sourceKey}:${row.priceType}`,
      observedAt: row.observedAt,
      methodVersion: CREATOR_PRICE_AT_CALL_VERSION,
    };
  }
  const reference = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, input.printingId),
        eq(tcgMarketSnapshot.priceType, "reference"),
        lte(tcgMarketSnapshot.observedAt, input.publishedAt),
      ),
    )
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  const ref = reference[0];
  if (!ref?.price || ref.observedAt.getTime() > input.publishedAt.getTime()) {
    return null;
  }
  return {
    price: ref.price,
    currency: ref.currency,
    source: `${ref.sourceKey}:${ref.priceType}`,
    observedAt: ref.observedAt,
    methodVersion: CREATOR_PRICE_AT_CALL_VERSION,
  };
}
