import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset, marketAssetPrice } from "../schema/asset.js";
import { classifyHttpStatus, createFetchTransport, ProviderHttpError, type HttpTransport } from "./transport.js";

export const ASSET_PRICE_SOURCE = "coingecko";
export const ASSET_PRICE_BASE_URL = "https://api.coingecko.com/api/v3";
/** Assets with no price history get one history request each, at most this many per run. */
export const ASSET_BACKFILL_PER_RUN = 2;
export const ASSET_BACKFILL_DAYS = 365;
/** Hard ceiling on requests in one run: one current-price request plus the backfills. */
export const ASSET_PRICE_MAX_REQUESTS = 1 + ASSET_BACKFILL_PER_RUN;

export type AssetPriceMode = "disabled" | "live";

/**
 * The asset price feed is off unless MARKET_ASSET_PRICE_MODE=live. Turning it
 * on is an operator decision (it is an additional live provider).
 */
export function resolveAssetPriceMode(env: NodeJS.ProcessEnv = process.env): AssetPriceMode {
  return env.MARKET_ASSET_PRICE_MODE?.trim().toLowerCase() === "live" ? "live" : "disabled";
}

export type AssetPriceSyncReport = {
  status: "skipped" | "completed" | "failed";
  reason: string | null;
  requests: number;
  inserted: number;
  backfilled: string[];
};

function headers(env: NodeJS.ProcessEnv): Record<string, string> {
  const key = env.COINGECKO_API_KEY?.trim();
  return key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" };
}

async function getJson(transport: HttpTransport, url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const response = await transport.fetch(url, { headers: headers(env) });
  const errorClass = classifyHttpStatus(response.status);
  if (errorClass !== "ok") throw new ProviderHttpError({ status: response.status, errorClass });
  try {
    return JSON.parse(response.bodyText) as unknown;
  } catch {
    throw new ProviderHttpError({ status: response.status, errorClass: "invalid_payload" });
  }
}

function positive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function insertPoints(
  db: Database,
  points: { assetId: string; observedAt: Date; price: number; currency: string; reference: string }[],
) {
  if (points.length === 0) return 0;
  const inserted = await db
    .insert(marketAssetPrice)
    .values(
      points.map((point) => ({
        id: `map_${point.assetId}_${ASSET_PRICE_SOURCE}_${point.observedAt.getTime()}`,
        assetId: point.assetId,
        sourceKey: ASSET_PRICE_SOURCE,
        observedAt: point.observedAt,
        price: point.price.toFixed(10),
        currency: point.currency,
        sourceReference: point.reference,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: marketAssetPrice.id });
  return inserted.length;
}

/**
 * Collects prices for active assets fed by CoinGecko: a one-time daily history
 * for up to ASSET_BACKFILL_PER_RUN assets that have none yet, then one request
 * for the current price of every asset with history. Points are append-only
 * and keep the request path as their source reference.
 */
export async function syncAssetPrices(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport } = {},
): Promise<AssetPriceSyncReport> {
  const env = input.env ?? process.env;
  const report: AssetPriceSyncReport = { status: "skipped", reason: null, requests: 0, inserted: 0, backfilled: [] };
  if (resolveAssetPriceMode(env) !== "live") return { ...report, reason: "disabled" };
  const assets = await db
    .select()
    .from(marketAsset)
    .where(and(eq(marketAsset.status, "active"), eq(marketAsset.priceSourceKey, ASSET_PRICE_SOURCE)));
  const fed = assets.filter((asset) => asset.priceSourceRef);
  if (fed.length === 0) return { ...report, reason: "no_assets" };
  const transport = input.transport ?? createFetchTransport();
  try {
    const withHistory = new Set(
      (
        await db
          .selectDistinct({ assetId: marketAssetPrice.assetId })
          .from(marketAssetPrice)
          .where(inArray(marketAssetPrice.assetId, fed.map((asset) => asset.id)))
      ).map((row) => row.assetId),
    );
    for (const asset of fed.filter((row) => !withHistory.has(row.id)).slice(0, ASSET_BACKFILL_PER_RUN)) {
      const currency = asset.quoteCurrency.toLowerCase();
      const path = `/coins/${encodeURIComponent(asset.priceSourceRef!)}/market_chart?vs_currency=${currency}&days=${ASSET_BACKFILL_DAYS}&interval=daily`;
      report.requests += 1;
      const body = (await getJson(transport, `${ASSET_PRICE_BASE_URL}${path}`, env)) as { prices?: unknown };
      const points = (Array.isArray(body.prices) ? body.prices : [])
        .map((pair) => (Array.isArray(pair) ? { at: positive(pair[0]), price: positive(pair[1]) } : null))
        .filter((pair): pair is { at: number; price: number } => pair?.at != null && pair.price != null)
        .map((pair) => ({
          assetId: asset.id,
          observedAt: new Date(pair.at),
          price: pair.price,
          currency: asset.quoteCurrency,
          reference: path,
        }));
      report.inserted += await insertPoints(db, points);
      report.backfilled.push(asset.assetKey);
      withHistory.add(asset.id);
    }
    // Only assets that already have history get a current price, so an asset
    // still waiting for its backfill is not left with a single recent point.
    const current = fed.filter((asset) => withHistory.has(asset.id));
    if (current.length === 0) return { ...report, status: "completed" };
    const currencies = [...new Set(current.map((asset) => asset.quoteCurrency.toLowerCase()))].join(",");
    const ids = current.map((asset) => asset.priceSourceRef!).join(",");
    const path = `/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(currencies)}&include_last_updated_at=true`;
    report.requests += 1;
    const body = (await getJson(transport, `${ASSET_PRICE_BASE_URL}${path}`, env)) as Record<string, Record<string, unknown>>;
    const points = current.flatMap((asset) => {
      const entry = body?.[asset.priceSourceRef!];
      const price = positive(entry?.[asset.quoteCurrency.toLowerCase()]);
      const updated = positive(entry?.last_updated_at);
      if (price == null || updated == null) return [];
      return [{ assetId: asset.id, observedAt: new Date(updated * 1000), price, currency: asset.quoteCurrency, reference: path }];
    });
    report.inserted += await insertPoints(db, points);
    return { ...report, status: "completed" };
  } catch (error) {
    return {
      ...report,
      status: "failed",
      reason: error instanceof ProviderHttpError ? error.errorClass : "unexpected",
    };
  }
}

export class AssetPriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPriceInputError";
  }
}

/**
 * Records one price point for an asset by its key, for feeds other than
 * CoinGecko (for example sealed product prices from a card marketplace).
 * The provider's record id is kept as the source reference; a repeat of the
 * same point is ignored. Future-dated points are rejected.
 */
export async function ingestAssetPrice(
  db: Database,
  input: {
    assetKey: string;
    sourceKey: string;
    sourceRecordId: string;
    observedAt: Date;
    price: number;
    currency: string;
    now?: Date;
  },
): Promise<{ status: "inserted" | "duplicate" }> {
  const now = input.now ?? new Date();
  if (!/^[a-z0-9_.-]{2,40}$/.test(input.sourceKey)) throw new AssetPriceInputError("source key is invalid.");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new AssetPriceInputError("currency must be a 3 letter code.");
  if (!Number.isFinite(input.price) || input.price <= 0) throw new AssetPriceInputError("price must be positive.");
  if (Number.isNaN(input.observedAt.getTime()) || input.observedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new AssetPriceInputError("observed_at is invalid or in the future.");
  }
  const [asset] = await db.select().from(marketAsset).where(eq(marketAsset.assetKey, input.assetKey)).limit(1);
  if (!asset) throw new AssetPriceInputError("asset not found.");
  const inserted = await db
    .insert(marketAssetPrice)
    .values({
      id: `map_${asset.id}_${input.sourceKey}_${input.observedAt.getTime()}`,
      assetId: asset.id,
      sourceKey: input.sourceKey,
      observedAt: input.observedAt,
      price: input.price.toFixed(10),
      currency: input.currency,
      sourceReference: input.sourceRecordId.slice(0, 200),
    })
    .onConflictDoNothing()
    .returning({ id: marketAssetPrice.id });
  return { status: inserted.length ? "inserted" : "duplicate" };
}
