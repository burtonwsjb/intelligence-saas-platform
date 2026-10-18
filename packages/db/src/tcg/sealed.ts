import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset } from "../schema/asset.js";
import { tcgSet } from "../schema/tcg.js";

export const SEALED_PRODUCT_TYPES = [
  "booster_pack",
  "booster_bundle",
  "booster_box",
  "elite_trainer_box",
  "collection",
  "tin",
  "other",
] as const;
export type SealedProductType = (typeof SEALED_PRODUCT_TYPES)[number];

/** The names people use for each product type; the first is the display name. */
export const SEALED_PRODUCT_NAMES: Record<SealedProductType, string[]> = {
  booster_pack: ["Booster Pack"],
  booster_bundle: ["Booster Bundle"],
  booster_box: ["Booster Box"],
  elite_trainer_box: ["Elite Trainer Box", "ETB"],
  collection: ["Collection"],
  tin: ["Tin"],
  other: ["Sealed"],
};

/** Standard products created for every set of a game. Others are added by the operator. */
export const STANDARD_SEALED_TYPES: Record<string, SealedProductType[]> = {
  pokemon: ["booster_pack", "booster_bundle", "booster_box", "elite_trainer_box"],
};
const DEFAULT_SEALED_TYPES: SealedProductType[] = ["booster_pack", "booster_box"];

export function sealedAssetKey(gameKey: string, setKey: string, productType: SealedProductType) {
  return `sealed:${gameKey}:${setKey}:${productType}`;
}

export function sealedAliases(setName: string, productType: SealedProductType): string[] {
  return SEALED_PRODUCT_NAMES[productType].map((name) => `${setName} ${name}`.toLowerCase());
}

/** Standard products are English; a set released only in another language gets none. */
function hasEnglishProducts(languageScope: string | null) {
  return languageScope == null || languageScope === "en" || languageScope === "multi";
}

/**
 * Creates the standard sealed products for every active set that is not a
 * promo set or released only in another language. Existing rows are never
 * changed, so an operator's edits (names, aliases, pausing) are kept.
 * Returns how many products were added.
 */
export async function syncSealedProducts(db: Database): Promise<{ added: number }> {
  const sets = await db.select().from(tcgSet).where(eq(tcgSet.status, "active"));
  const values = sets
    .filter((set) => !/promo/i.test(set.name) && hasEnglishProducts(set.languageScope))
    .flatMap((set) =>
      (STANDARD_SEALED_TYPES[set.gameKey] ?? DEFAULT_SEALED_TYPES).map((productType) => ({
        id: `mas_sealed_${set.id}_${productType}`,
        assetKey: sealedAssetKey(set.gameKey, set.canonicalSetKey, productType),
        kind: "sealed",
        displayName: `${set.name} ${SEALED_PRODUCT_NAMES[productType][0]}`,
        aliases: sealedAliases(set.name, productType),
        quoteCurrency: "USD",
        gameKey: set.gameKey,
        setId: set.id,
        productType,
        languageCode: "en",
      })),
    );
  if (values.length === 0) return { added: 0 };
  const inserted = await db
    .insert(marketAsset)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: marketAsset.id });
  return { added: inserted.length };
}

/** Sealed products, optionally for one game and set, ordered by set and product type. */
export async function listSealedProducts(db: Database, input: { gameKey?: string; setKey?: string } = {}) {
  const clauses = [eq(marketAsset.kind, "sealed"), eq(marketAsset.status, "active")];
  if (input.gameKey) clauses.push(eq(marketAsset.gameKey, input.gameKey));
  if (input.setKey) clauses.push(eq(tcgSet.canonicalSetKey, input.setKey));
  return db
    .select({
      id: marketAsset.id,
      assetKey: marketAsset.assetKey,
      displayName: marketAsset.displayName,
      productType: marketAsset.productType,
      gameKey: marketAsset.gameKey,
      setKey: tcgSet.canonicalSetKey,
      setName: tcgSet.name,
      languageCode: marketAsset.languageCode,
    })
    .from(marketAsset)
    .innerJoin(tcgSet, eq(tcgSet.id, marketAsset.setId))
    .where(and(...clauses))
    .orderBy(tcgSet.name, sql`array_position(${sql.raw(`ARRAY[${SEALED_PRODUCT_TYPES.map((type) => `'${type}'`).join(",")}]`)}, ${marketAsset.productType})`);
}
