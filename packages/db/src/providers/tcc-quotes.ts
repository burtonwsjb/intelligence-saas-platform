import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset, marketAssetPrice } from "../schema/asset.js";
import { creatorCall } from "../schema/creator.js";
import { tcgCardConcept, tcgPrinting, tcgSet } from "../schema/tcg.js";
import { tcgMarketIngest } from "../schema/tcg-market.js";
import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import { ingestAssetPrice } from "./asset-prices.js";
import { createFetchTransport, requireOkJson, type HttpTransport } from "./transport.js";

/** TCG Card Central's server-to-server price feed (POST, Bearer TCC_API_TOKEN). */
export const TCC_QUOTES_PATH = "/api/public/integrations/social-signal/quotes";
/** Items per request; the feed accepts at most 50. */
export const TCC_QUOTE_BATCH = 50;
/** At most this many items are priced per run, so a run makes at most 4 requests. */
export const TCC_QUOTE_MAX_ITEMS = 200;
/** Calls made within this many days keep their card or product priced every day. */
export const TCC_WATCH_DAYS = 120;
export const TCC_QUOTE_GAMES = ["pokemon", "one_piece", "dragon_ball", "yugioh"] as const;
const SEALED_TYPES = ["booster_pack", "booster_bundle", "booster_box", "elite_trainer_box"];

type CardTarget = {
  kind: "card";
  printingId: string;
  game: string;
  setKey: string;
  setName: string;
  collectorNumber: string;
  cardName: string;
  language: string;
  variant: string;
};
type SealedTarget = { kind: "sealed"; assetKey: string; game: string; setName: string; productType: string };
type Target = CardTarget | SealedTarget;

type Quote =
  | {
      status: "ok";
      currency: string;
      price: number;
      low_price: number | null;
      mid_price: number | null;
      high_price: number | null;
      sub_type: string;
      product_id: number;
      product_name: string;
      group_name: string;
      observed_at: string;
      price_date: string;
    }
  | { status: string; reason?: string };

export type TccQuoteReport = {
  requested: number;
  requests: number;
  cards: number;
  sealed: number;
  notFound: number;
  records: TcgMarketRecordInput[];
};

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

export function cardQuoteRecordId(printingId: string, priceDate: string) {
  return `tcc:quote:${printingId}:${priceDate}`;
}

/**
 * Cards and sealed products to price today: those named in calls made in the
 * last TCC_WATCH_DAYS days (newest first), skipping any already priced today.
 */
export async function listQuoteTargets(db: Database, now = new Date(), limit = TCC_QUOTE_MAX_ITEMS): Promise<Target[]> {
  const since = new Date(now.getTime() - TCC_WATCH_DAYS * 86_400_000);
  const today = utcDay(now);
  const cards = await db
    .select({
      printingId: tcgPrinting.id,
      game: tcgPrinting.gameKey,
      setKey: tcgSet.canonicalSetKey,
      setName: tcgSet.name,
      collectorNumber: tcgPrinting.collectorNumber,
      cardName: tcgCardConcept.canonicalName,
      language: tcgPrinting.languageCode,
      variant: tcgPrinting.variantKey,
      latest: sql<Date>`max(${creatorCall.publishedAt})`,
    })
    .from(creatorCall)
    .innerJoin(tcgPrinting, eq(tcgPrinting.id, creatorCall.printingId))
    .innerJoin(tcgSet, eq(tcgSet.id, tcgPrinting.setId))
    .innerJoin(tcgCardConcept, eq(tcgCardConcept.id, tcgPrinting.cardId))
    .where(
      and(
        isNotNull(creatorCall.printingId),
        gte(creatorCall.publishedAt, since),
        inArray(tcgPrinting.gameKey, [...TCC_QUOTE_GAMES]),
      ),
    )
    .groupBy(tcgPrinting.id, tcgSet.canonicalSetKey, tcgSet.name, tcgCardConcept.canonicalName)
    .orderBy(desc(sql`max(${creatorCall.publishedAt})`))
    .limit(limit * 2);
  const sealed = await db
    .select({
      assetId: marketAsset.id,
      assetKey: marketAsset.assetKey,
      game: marketAsset.gameKey,
      setName: tcgSet.name,
      productType: marketAsset.productType,
    })
    .from(creatorCall)
    .innerJoin(marketAsset, eq(marketAsset.id, creatorCall.assetId))
    .innerJoin(tcgSet, eq(tcgSet.id, marketAsset.setId))
    .where(and(eq(marketAsset.kind, "sealed"), gte(creatorCall.publishedAt, since)))
    .groupBy(marketAsset.id, tcgSet.name)
    .orderBy(desc(sql`max(${creatorCall.publishedAt})`))
    .limit(limit);

  const pricedCards = new Set(
    cards.length
      ? (
          await db
            .select({ id: tcgMarketIngest.sourceRecordId })
            .from(tcgMarketIngest)
            .where(
              and(
                eq(tcgMarketIngest.sourceKey, "tcg_card_central"),
                inArray(
                  tcgMarketIngest.sourceRecordId,
                  cards.map((row) => cardQuoteRecordId(row.printingId, today)),
                ),
              ),
            )
        ).map((row) => row.id)
      : [],
  );
  const pricedAssets = new Set(
    sealed.length
      ? (
          await db
            .select({ assetId: marketAssetPrice.assetId })
            .from(marketAssetPrice)
            .where(
              and(
                eq(marketAssetPrice.sourceKey, "tcg_card_central"),
                inArray(
                  marketAssetPrice.assetId,
                  sealed.map((row) => row.assetId),
                ),
                gte(marketAssetPrice.observedAt, new Date(`${today}T00:00:00Z`)),
              ),
            )
        ).map((row) => row.assetId)
      : [],
  );

  const targets: Target[] = [];
  for (const row of cards) {
    if (pricedCards.has(cardQuoteRecordId(row.printingId, today))) continue;
    targets.push({ kind: "card", ...row });
  }
  for (const row of sealed) {
    if (pricedAssets.has(row.assetId) || !row.game || !row.productType || !SEALED_TYPES.includes(row.productType)) continue;
    targets.push({ kind: "sealed", assetKey: row.assetKey, game: row.game, setName: row.setName, productType: row.productType });
  }
  return targets.slice(0, limit);
}

function requestItem(target: Target) {
  return target.kind === "card"
    ? {
        kind: "card",
        game: target.game,
        set_name: target.setName,
        card_number: target.collectorNumber,
        card_name: target.cardName,
        variant: target.variant,
        language: target.language,
      }
    : { kind: "sealed", game: target.game, set_name: target.setName, product_type: target.productType };
}

function cardRecord(target: CardTarget, quote: Extract<Quote, { status: "ok" }>): TcgMarketRecordInput {
  return {
    provider: "tcg_card_central",
    provider_record_id: cardQuoteRecordId(target.printingId, quote.price_date),
    event_type: "tcg.market.reference_price",
    market_type: "market_price",
    price_type: "reference",
    observed_at: quote.observed_at,
    currency: quote.currency,
    // TCGplayer's market price is product level, not split by condition.
    condition: "unknown",
    raw_condition: "product_level",
    price: quote.price,
    low_price: quote.low_price,
    high_price: quote.high_price,
    median_price: quote.mid_price,
    source_reference: `tcgplayer:${quote.product_id}`,
    printing: {
      game: target.game,
      set: target.setKey,
      collector_number: target.collectorNumber,
      language: target.language,
      variant: target.variant,
    },
    attributes: {
      tcgplayer_product_id: quote.product_id,
      tcgplayer_product_name: quote.product_name,
      tcgplayer_group_name: quote.group_name,
      tcgplayer_sub_type: quote.sub_type,
      price_source: "tcgplayer_market_via_tcg_card_central",
    },
  };
}

/**
 * Prices today's watched cards and sealed products through TCG Card Central.
 * Card prices come back as market records for the caller to ingest; sealed
 * prices are stored directly as asset prices. Bounded to TCC_QUOTE_MAX_ITEMS
 * items and ceil(items / 50) requests.
 */
export async function collectTccQuotes(
  db: Database,
  input: { baseUrl: string; token: string; transport?: HttpTransport; now?: Date; limit?: number },
): Promise<TccQuoteReport> {
  const transport = input.transport ?? createFetchTransport();
  const now = input.now ?? new Date();
  const targets = await listQuoteTargets(db, now, Math.min(input.limit ?? TCC_QUOTE_MAX_ITEMS, TCC_QUOTE_MAX_ITEMS));
  const report: TccQuoteReport = { requested: targets.length, requests: 0, cards: 0, sealed: 0, notFound: 0, records: [] };
  const url = `${input.baseUrl.replace(/\/$/, "")}${TCC_QUOTES_PATH}`;
  for (let start = 0; start < targets.length; start += TCC_QUOTE_BATCH) {
    const batch = targets.slice(start, start + TCC_QUOTE_BATCH);
    report.requests += 1;
    const response = await transport.fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${input.token}` },
      body: JSON.stringify({ items: batch.map(requestItem) }),
    });
    const body = requireOkJson(response, (value) => value as { quotes?: Quote[] });
    const quotes = Array.isArray(body.quotes) ? body.quotes : [];
    for (const [index, target] of batch.entries()) {
      const quote = quotes[index];
      if (!quote || quote.status !== "ok" || !("price" in quote) || quote.currency !== "USD") {
        report.notFound += 1;
        continue;
      }
      if (target.kind === "card") {
        report.records.push(cardRecord(target, quote));
        report.cards += 1;
      } else {
        const result = await ingestAssetPrice(db, {
          assetKey: target.assetKey,
          sourceKey: "tcg_card_central",
          sourceRecordId: `tcc:quote:${target.assetKey}:${quote.price_date}:tcgplayer:${quote.product_id}`,
          observedAt: new Date(quote.observed_at),
          price: quote.price,
          currency: "USD",
          now,
        });
        if (result.status === "inserted") report.sealed += 1;
      }
    }
  }
  return report;
}
