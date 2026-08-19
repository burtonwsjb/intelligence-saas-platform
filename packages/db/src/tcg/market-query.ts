import { and, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import type { Database } from "../client.js";
import { computeTcgAskSoldSpread, resolveWindow, rollingMedian } from "./market-identity.js";

export type TcgMarketQueryFilter = {
  printingId: string;
  sourceKey?: string;
  marketType?: string;
  priceType?: string;
  condition?: string;
  gradingCompany?: string | null;
  gradeLabel?: string | null;
  currency?: string;
  from?: Date;
  to?: Date;
};

function filters(input: TcgMarketQueryFilter): SQL[] {
  const clauses: SQL[] = [eq(tcgMarketSnapshot.printingId, input.printingId)];
  if (input.sourceKey) {
    clauses.push(eq(tcgMarketSnapshot.sourceKey, input.sourceKey));
  }
  if (input.marketType) {
    clauses.push(eq(tcgMarketSnapshot.marketType, input.marketType));
  }
  if (input.priceType) {
    clauses.push(eq(tcgMarketSnapshot.priceType, input.priceType));
  }
  if (input.condition) {
    clauses.push(eq(tcgMarketSnapshot.condition, input.condition));
  }
  if (input.currency) {
    clauses.push(eq(tcgMarketSnapshot.currency, input.currency));
  }
  if (input.gradingCompany === null) {
    clauses.push(isNull(tcgMarketSnapshot.gradingCompany));
  } else if (input.gradingCompany) {
    clauses.push(eq(tcgMarketSnapshot.gradingCompany, input.gradingCompany));
  }
  if (input.gradeLabel) {
    clauses.push(eq(tcgMarketSnapshot.gradeLabel, input.gradeLabel));
  }
  if (input.from) {
    clauses.push(gte(tcgMarketSnapshot.observedAt, input.from));
  }
  if (input.to) {
    clauses.push(lte(tcgMarketSnapshot.observedAt, input.to));
  }
  return clauses;
}

export async function listTcgMarketSnapshots(db: Database, input: TcgMarketQueryFilter) {
  return db
    .select()
    .from(tcgMarketSnapshot)
    .where(and(...filters(input)))
    .orderBy(desc(tcgMarketSnapshot.observedAt));
}

export async function getLatestTcgMarketSnapshot(db: Database, input: TcgMarketQueryFilter) {
  const [row] = await db
    .select()
    .from(tcgMarketSnapshot)
    .where(and(...filters(input)))
    .orderBy(desc(tcgMarketSnapshot.observedAt))
    .limit(1);
  return row ?? null;
}

export async function listTcgSoldHistory(db: Database, input: TcgMarketQueryFilter) {
  return listTcgMarketSnapshots(db, { ...input, priceType: "sold" });
}

export async function listTcgListingHistory(db: Database, input: TcgMarketQueryFilter) {
  return listTcgMarketSnapshots(db, { ...input, marketType: "marketplace_listing" });
}

export async function getTcgAskSoldSpread(db: Database, input: TcgMarketQueryFilter) {
  const latestSold = await getLatestTcgMarketSnapshot(db, { ...input, priceType: "sold" });
  const latestAsk = await getLatestTcgMarketSnapshot(db, {
    ...input,
    marketType: "marketplace_listing",
    priceType: "asking",
  });
  const sold = latestSold?.price == null ? null : Number(latestSold.price);
  const ask = latestAsk?.lowPrice != null ? Number(latestAsk.lowPrice) : latestAsk?.price == null ? null : Number(latestAsk.price);
  if (sold == null || ask == null) {
    return computeTcgAskSoldSpread({ lowestAsk: Number.NaN, latestSold: Number.NaN });
  }
  return computeTcgAskSoldSpread({ lowestAsk: ask, latestSold: sold });
}

export function summarizeTcgLiquidityInputs(rows: { observedAt: Date; salesCount: number | null; listingCount: number | null; sellerCount: number | null; bidCount: number | null }[]) {
  const sales = rows.map((row) => row.observedAt.getTime()).sort((a, b) => a - b);
  const gaps = sales.slice(1).map((time, index) => time - sales[index]!);
  return {
    observation_count: rows.length,
    sales_frequency: rows.length,
    listing_count: rows.find((row) => row.listingCount != null)?.listingCount ?? null,
    seller_count: rows.find((row) => row.sellerCount != null)?.sellerCount ?? null,
    bid_count: rows.find((row) => row.bidCount != null)?.bidCount ?? null,
    median_ms_between_observations: gaps.length ? rollingMedian(gaps) : null,
  };
}

export function computeDailyReturns(pricesByTime: { observedAt: Date; price: number }[]) {
  const byDay = new Map<string, number>();
  for (const point of [...pricesByTime].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())) {
    const day = point.observedAt.toISOString().slice(0, 10);
    byDay.set(day, point.price);
  }
  const days = [...byDay.entries()];
  const returns: { day: string; daily_return: number }[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const prev = days[i - 1]![1];
    const current = days[i]![1];
    if (prev > 0) {
      returns.push({ day: days[i]![0], daily_return: current / prev - 1 });
    }
  }
  return returns;
}

export function listWindow(preset: "24h" | "7d" | "30d" | "90d" | "1y" | "all", now?: Date) {
  return resolveWindow(preset, now);
}
