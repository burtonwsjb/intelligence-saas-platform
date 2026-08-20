import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgCardConcept, tcgPrinting, tcgSet } from "../schema/tcg.js";
import { tcgScoreSnapshot } from "../schema/scoring.js";
import { tcgIndexDefinition, tcgIndexLevel } from "../schema/analytics.js";
import { tcgPrediction } from "../schema/prediction.js";
import { creatorCall } from "../schema/creator.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { getLatestTcgMarketSnapshot, getTcgAskSoldSpread, listTcgSoldHistory } from "../tcg/market-query.js";
import { getLatestScoreSnapshot } from "../scoring/persist.js";
import { getMarketFeatureSnapshot } from "../analytics/features.js";
import { listCallsByPrinting } from "../creator/query.js";
import { listMembershipAsOf } from "../analytics/index-engine.js";

export type OpportunityFilter = {
  game?: string;
  language?: string;
  set?: string;
  recommendation?: string;
  minOpportunity?: number;
  maxRisk?: number;
  minLiquidity?: number;
  limit?: number;
};

export type PrintingIdentity = {
  printingId: string;
  gameKey: string;
  cardName: string;
  setName: string;
  setKey: string;
  collectorNumber: string;
  languageCode: string;
  variantKey: string;
  rarity: string | null;
  finish: string | null;
  canonicalPrintingKey: string;
};

export function formatPrintingIdentity(identity: PrintingIdentity): string {
  return [
    identity.cardName,
    identity.setName,
    `#${identity.collectorNumber}`,
    identity.languageCode,
    identity.variantKey,
  ].join(" · ");
}

async function printingIdentityRows(db: Database, printingId?: string) {
  const query = db
    .select({
      printingId: tcgPrinting.id,
      gameKey: tcgPrinting.gameKey,
      cardName: tcgCardConcept.canonicalName,
      setName: tcgSet.name,
      setKey: tcgSet.canonicalSetKey,
      collectorNumber: tcgPrinting.collectorNumber,
      languageCode: tcgPrinting.languageCode,
      variantKey: tcgPrinting.variantKey,
      rarity: tcgPrinting.rarity,
      finish: tcgPrinting.finish,
      canonicalPrintingKey: tcgPrinting.canonicalPrintingKey,
    })
    .from(tcgPrinting)
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId));
  if (printingId) {
    return query.where(eq(tcgPrinting.id, printingId));
  }
  return query;
}

export async function listPrintingCatalog(db: Database, filter?: { game?: string; language?: string; set?: string }) {
  const rows = await printingIdentityRows(db);
  return rows.filter((row) => {
    if (filter?.game && row.gameKey !== filter.game) return false;
    if (filter?.language && row.languageCode !== filter.language) return false;
    if (filter?.set && row.setKey !== filter.set) return false;
    return true;
  });
}

export async function getPrintingIdentity(db: Database, printingId: string) {
  const [row] = await printingIdentityRows(db, printingId);
  return row ?? null;
}

export async function listLatestOpportunities(db: Database, filter: OpportunityFilter = {}) {
  const scores = await db.select().from(tcgScoreSnapshot).orderBy(desc(tcgScoreSnapshot.asOf));
  const latest = new Map<string, (typeof scores)[number]>();
  for (const score of scores) {
    if (!latest.has(score.printingId)) {
      latest.set(score.printingId, score);
    }
  }
  const identities = await listPrintingCatalog(db);
  const identityById = new Map(identities.map((row) => [row.printingId, row]));
  const snapshots = await db.select().from(tcgMarketSnapshot).orderBy(desc(tcgMarketSnapshot.observedAt));
  const latestPrice = new Map<string, { price: string | null; sourceKey: string; observedAt: Date; currency: string }>();
  for (const snapshot of snapshots) {
    if (!latestPrice.has(snapshot.printingId) && snapshot.price) {
      latestPrice.set(snapshot.printingId, {
        price: snapshot.price,
        sourceKey: snapshot.sourceKey,
        observedAt: snapshot.observedAt,
        currency: snapshot.currency,
      });
    }
  }
  const rows = [...latest.values()]
    .map((score) => {
      const identity = identityById.get(score.printingId);
      if (!identity) return null;
      return { score, identity, market: latestPrice.get(score.printingId) ?? null };
    })
    .filter(
      (row): row is {
        score: (typeof scores)[number];
        identity: PrintingIdentity;
        market: { price: string | null; sourceKey: string; observedAt: Date; currency: string } | null;
      } => row !== null,
    )
    .filter((row) => {
      if (filter.game && row.identity.gameKey !== filter.game) return false;
      if (filter.language && row.identity.languageCode !== filter.language) return false;
      if (filter.set && row.identity.setKey !== filter.set) return false;
      if (filter.recommendation && row.score.recommendation !== filter.recommendation) return false;
      if (filter.minOpportunity != null && Number(row.score.opportunityScore) < filter.minOpportunity) return false;
      if (filter.maxRisk != null && Number(row.score.riskScore) > filter.maxRisk) return false;
      if (filter.minLiquidity != null && Number(row.score.liquidityScore) < filter.minLiquidity) return false;
      return true;
    })
    .sort((a, b) => Number(b.score.opportunityScore) - Number(a.score.opportunityScore))
    .slice(0, Math.min(filter.limit ?? 50, 200));
  return rows;
}

export async function getPrintingWorkspace(db: Database, printingId: string) {
  const identity = await getPrintingIdentity(db, printingId);
  if (!identity) {
    return null;
  }
  const [sold, listing, reference, score, features, calls, predictions, spread] = await Promise.all([
    listTcgSoldHistory(db, { printingId }),
    getLatestTcgMarketSnapshot(db, { printingId, marketType: "marketplace_listing" }),
    getLatestTcgMarketSnapshot(db, { printingId, priceType: "reference" }),
    getLatestScoreSnapshot(db, printingId),
    getMarketFeatureSnapshot(db, { printingId }),
    listCallsByPrinting(db, printingId),
    db.select().from(tcgPrediction).where(eq(tcgPrediction.printingId, printingId)).orderBy(desc(tcgPrediction.issuedAt)),
    getTcgAskSoldSpread(db, { printingId }),
  ]);
  const latestSold = sold[0] ?? null;
  return {
    identity,
    sold,
    latestSold,
    listing,
    reference,
    score,
    features,
    calls,
    predictions,
    spread,
  };
}

export async function getIndexWorkspace(db: Database, indexKey: string) {
  const [definition] = await db
    .select()
    .from(tcgIndexDefinition)
    .where(eq(tcgIndexDefinition.indexKey, indexKey))
    .limit(1);
  if (!definition) {
    return null;
  }
  const levels = await db
    .select()
    .from(tcgIndexLevel)
    .where(eq(tcgIndexLevel.indexKey, indexKey))
    .orderBy(tcgIndexLevel.observedAt);
  const latest = levels[levels.length - 1] ?? null;
  const first = levels[0] ?? null;
  const ret =
    first && latest && Number(first.indexValue) > 0
      ? Number(latest.indexValue) / Number(first.indexValue) - 1
      : null;
  const members = latest ? await listMembershipAsOf(db, indexKey, latest.observedAt) : [];
  return { definition, levels, latest, returnPct: ret, members };
}

export function publishedPredictionsForCustomer<T extends { visibility: string }>(
  predictions: T[],
  access: { entitled: boolean; flagEnabled: boolean },
): T[] {
  if (!access.entitled || !access.flagEnabled) {
    return [];
  }
  return predictions.filter((row) => row.visibility === "published");
}

export async function listIndexOverview(db: Database) {
  const definitions = await db.select().from(tcgIndexDefinition);
  const rows = [];
  for (const definition of definitions) {
    const [latest] = await db
      .select()
      .from(tcgIndexLevel)
      .where(eq(tcgIndexLevel.indexKey, definition.indexKey))
      .orderBy(desc(tcgIndexLevel.observedAt))
      .limit(1);
    rows.push({ definition, latest });
  }
  return rows;
}

export async function listRecentCreatorCalls(db: Database, limit = 8) {
  return db.select().from(creatorCall).orderBy(desc(creatorCall.publishedAt)).limit(limit);
}

export async function countCatalog(db: Database) {
  const printings = await db.select({ count: sql<number>`count(*)::int` }).from(tcgPrinting);
  const scores = await db.select({ count: sql<number>`count(*)::int` }).from(tcgScoreSnapshot);
  return { printings: printings[0]?.count ?? 0, scores: scores[0]?.count ?? 0 };
}
