import { and, asc, desc, eq, gt, gte, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset, marketAssetPrice } from "../schema/asset.js";
import { creatorCall, creatorCallOutcome } from "../schema/creator.js";
import { tcgSet } from "../schema/tcg.js";
import { sourceContent } from "../schema/source.js";
import { DeterministicCreatorCallExtractor, type CreatorCallExtractor } from "./extract.js";
import { CREATOR_PRICE_AT_CALL_VERSION, fingerprintCreatorCall } from "./identity.js";
import { ensureCreatorForSourceAccount } from "./ingest.js";

export const ASSET_CALL_RESOLUTION = "asset_match";
/** A price older than this before the post is too stale to anchor the call. */
export const ASSET_PRICE_MAX_AGE_MS = 2 * 86_400_000;
/** At most this many assets are read out of one post. */
export const ASSET_MATCHES_PER_CONTENT = 3;

export type MarketAssetRow = typeof marketAsset.$inferSelect;

export async function listActiveAssets(db: Database): Promise<MarketAssetRow[]> {
  return db.select().from(marketAsset).where(eq(marketAsset.status, "active")).orderBy(asc(marketAsset.assetKey));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Assets named in the text by one of their aliases as a whole word, in the order listed. */
export function matchAssets<T extends { id: string; aliases: string[] }>(text: string, assets: T[]): T[] {
  const matched: T[] = [];
  for (const asset of assets) {
    const hit = asset.aliases.some((alias) => {
      const word = alias.trim();
      if (!word) return false;
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
    });
    if (hit) matched.push(asset);
  }
  return matched;
}

/** The asset a topic is about, when the whole topic is one of its names (for example "Bitcoin" or "BTC"). */
export async function findAssetForTopic(db: Database, query: string): Promise<MarketAssetRow | null> {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const assets = await listActiveAssets(db);
  return (
    assets.find(
      (asset) => asset.displayName.toLowerCase() === needle || asset.aliases.some((alias) => alias.toLowerCase() === needle),
    ) ?? null
  );
}

/** The newest price at or before `at`, if it is recent enough to stand for the price at that moment. */
export async function assetPriceAt(db: Database, input: { assetId: string; at: Date; maxAgeMs?: number }) {
  const [row] = await db
    .select()
    .from(marketAssetPrice)
    .where(
      and(
        eq(marketAssetPrice.assetId, input.assetId),
        lte(marketAssetPrice.observedAt, input.at),
        gte(marketAssetPrice.observedAt, new Date(input.at.getTime() - (input.maxAgeMs ?? ASSET_PRICE_MAX_AGE_MS))),
      ),
    )
    .orderBy(desc(marketAssetPrice.observedAt))
    .limit(1);
  return row ?? null;
}

/** Prices after `from` up to and including `to`, oldest first. */
export async function assetPricesBetween(db: Database, input: { assetId: string; from: Date; to: Date }) {
  return db
    .select()
    .from(marketAssetPrice)
    .where(
      and(
        eq(marketAssetPrice.assetId, input.assetId),
        gt(marketAssetPrice.observedAt, input.from),
        lte(marketAssetPrice.observedAt, input.to),
      ),
    )
    .orderBy(asc(marketAssetPrice.observedAt));
}

/**
 * Reads calls about non-card assets out of one post. The same extractor as
 * card calls decides whether the post makes a call; the asset comes from the
 * post naming it. The price at call is the newest price no later than the
 * post, so nothing after publication is read.
 */
export async function extractAssetCallsFromContent(
  db: Database,
  contentId: string,
  extractor: CreatorCallExtractor = new DeterministicCreatorCallExtractor(),
) {
  const [content] = await db.select().from(sourceContent).where(eq(sourceContent.id, contentId)).limit(1);
  if (!content) throw new Error("source content not found.");
  const text = [content.title, content.summary, content.excerpt].filter(Boolean).join(" ");
  const assets = matchAssets(text, await listActiveAssets(db)).slice(0, ASSET_MATCHES_PER_CONTENT);
  if (assets.length === 0) return [];
  const candidate = await extractor.extract({ text });
  if (!candidate) return assets.map((asset) => ({ assetId: asset.id, status: "not_a_call" as const }));
  const { creator } = await ensureCreatorForSourceAccount(db, content.accountId);
  const results = [];
  for (const asset of assets) {
    const fingerprint = fingerprintCreatorCall([
      "asset",
      creator.id,
      content.id,
      asset.id,
      candidate.direction,
      candidate.horizon_code,
      extractor.version,
    ]);
    const [existing] = await db.select().from(creatorCall).where(eq(creatorCall.fingerprint, fingerprint)).limit(1);
    if (existing) {
      results.push({ assetId: asset.id, status: "duplicate" as const, call: existing });
      continue;
    }
    const price = await assetPriceAt(db, { assetId: asset.id, at: content.publishedAt });
    const id = crypto.randomUUID();
    await db.insert(creatorCall).values({
      id,
      creatorId: creator.id,
      sourceAccountId: content.accountId,
      contentId: content.id,
      publishedAt: content.publishedAt,
      assetId: asset.id,
      resolutionStatus: ASSET_CALL_RESOLUTION,
      priceAtCall: price?.price ?? null,
      priceCurrency: price?.currency ?? null,
      priceSource: price ? `${price.sourceKey}:asset` : null,
      priceObservedAt: price?.observedAt ?? null,
      priceMethodVersion: price ? CREATOR_PRICE_AT_CALL_VERSION : null,
      direction: candidate.direction,
      targetPrice: candidate.target_price == null ? null : String(candidate.target_price),
      targetPercent: candidate.target_percent == null ? null : String(candidate.target_percent),
      horizonCode: candidate.horizon_code,
      horizonCustomDays: candidate.horizon_custom_days == null ? null : String(candidate.horizon_custom_days),
      statedConfidence: candidate.stated_confidence == null ? null : candidate.stated_confidence.toFixed(4),
      extractionConfidence: candidate.extraction_confidence.toFixed(4),
      extractionVersion: extractor.version,
      fingerprint,
      status: "finalized",
      evidence: {
        extractor_evidence: candidate.evidence,
        asset_key: asset.assetKey,
        matched_by: "alias",
        published_at: content.publishedAt.toISOString(),
      },
    });
    await db.insert(creatorCallOutcome).values({
      id: crypto.randomUUID(),
      callId: id,
      evaluationStatus: "pending",
      startingPrice: price?.price ?? null,
    });
    const [call] = await db.select().from(creatorCall).where(eq(creatorCall.id, id)).limit(1);
    results.push({ assetId: asset.id, status: "processed" as const, call: call! });
  }
  return results;
}

/** Active assets for the API, optionally narrowed by kind, game and set. */
export async function listMarketAssets(
  db: Database,
  input: { kind?: string; gameKey?: string; setKey?: string; limit?: number } = {},
) {
  const clauses = [eq(marketAsset.status, "active")];
  if (input.kind) clauses.push(eq(marketAsset.kind, input.kind));
  if (input.gameKey) clauses.push(eq(marketAsset.gameKey, input.gameKey));
  if (input.setKey) clauses.push(eq(tcgSet.canonicalSetKey, input.setKey));
  return db
    .select({ asset: marketAsset, setKey: tcgSet.canonicalSetKey, setName: tcgSet.name })
    .from(marketAsset)
    .leftJoin(tcgSet, eq(tcgSet.id, marketAsset.setId))
    .where(and(...clauses))
    .orderBy(asc(marketAsset.assetKey))
    .limit(Math.max(1, Math.min(input.limit ?? 500, 500)));
}

export async function getMarketAssetByKey(db: Database, assetKey: string) {
  const [row] = await db
    .select({ asset: marketAsset, setKey: tcgSet.canonicalSetKey, setName: tcgSet.name })
    .from(marketAsset)
    .leftJoin(tcgSet, eq(tcgSet.id, marketAsset.setId))
    .where(eq(marketAsset.assetKey, assetKey))
    .limit(1);
  return row ?? null;
}
