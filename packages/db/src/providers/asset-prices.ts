import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset, marketAssetPrice } from "../schema/asset.js";

export class AssetPriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPriceInputError";
  }
}

/**
 * Records one price point for an asset by its key, for example a
 * sealed product price from a card marketplace.
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
