import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { marketAsset } from "../schema/asset.js";
import { tcgSet } from "../schema/tcg.js";
import { detectionKey } from "../source/card-detect.js";

export function setAssetKey(gameKey: string, setKey: string) {
  return `set:${gameKey}:${setKey}`;
}

/**
 * The names a post may use for a set: its catalog name and, for names with a
 * code prefix ("SV: Prismatic Evolutions"), the name without it. Names card
 * detection would not trust (too short, numeric, a common word) are left out.
 */
export function setAliasCandidates(name: string): string[] {
  const full = name.trim().toLowerCase();
  const stripped = full.match(/^[a-z0-9.]{1,8}:\s+(.+)$/)?.[1]?.trim();
  return [...new Set([full, stripped].filter((alias): alias is string => !!alias && detectionKey(alias) != null))];
}

/**
 * Creates one "set" market asset per active set, so a post that calls a whole
 * set ("Ascended Heroes is going to rise") becomes a call that can be scored.
 * A name that more than one active set shares (an English and a Japanese set
 * with the same name) is no one's alias: such a post cannot say which set it
 * means, so it stays unbound. Existing rows are never changed, so an
 * operator's edits are kept. Returns how many set assets were added.
 */
export async function syncSetAssets(db: Database): Promise<{ added: number }> {
  const sets = await db.select().from(tcgSet).where(eq(tcgSet.status, "active"));
  const aliasCount = new Map<string, number>();
  for (const set of sets) {
    for (const alias of setAliasCandidates(set.name)) aliasCount.set(alias, (aliasCount.get(alias) ?? 0) + 1);
  }
  const values = sets
    .filter((set) => !/promo/i.test(set.name))
    .map((set) => {
      const aliases = setAliasCandidates(set.name).filter((alias) => aliasCount.get(alias) === 1);
      return {
        id: `mas_set_${set.id}`,
        assetKey: setAssetKey(set.gameKey, set.canonicalSetKey),
        kind: "set",
        displayName: set.name,
        aliases,
        quoteCurrency: "USD",
        gameKey: set.gameKey,
        setId: set.id,
      };
    });
  if (values.length === 0) return { added: 0 };
  const inserted = await db
    .insert(marketAsset)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: marketAsset.id });
  return { added: inserted.length };
}
