/**
 * Card lists built from tcgcsv.com for games TCG Card Central has no catalog
 * for (TCGCSV_CATALOG_GAMES: Marvel, Union Arena, My Little Pony), owner
 * request 2026-11-20. Only categories the owner picked by id
 * (TCGCSV_CATALOG_CATEGORY_IDS) are ever read, because a game name such as
 * "Marvel" can match several TCGplayer product lines.
 *
 * For each group (set) the matching step reads, every product with a card
 * number becomes an English printing: set = the group (key from its
 * abbreviation, else its name), card = the product name before " - ", "(" or
 * "[", variant from its price sub-types (Normal -> normal, Foil/Holofoil ->
 * holofoil, Reverse Holofoil -> reverse_holo) and "parallel" for products
 * marked parallel / alternate art. Sealed products (no number) are skipped.
 * The matching step then links these printings to their product the same
 * way as every other game, so anything ambiguous stays unlinked.
 *
 * Catalog rows are write-once (UPDATE/DELETE are refused by triggers), so a
 * printing is only created when its set, number, language and variant are
 * not already taken.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgCardConcept, tcgPrinting, tcgSet } from "../schema/tcg.js";
import { stableId } from "../tcg/catalog.js";
import { canonicalPrintingKey, normalizeCollectorNumber, normalizeTcgName } from "../tcg/identity.js";
import type { TcgcsvPriceRow } from "./tcgcsv-common.js";
import { normName } from "./tcgcsv-common.js";

export type TcgcsvProduct = {
  productId?: unknown;
  name?: unknown;
  extendedData?: Array<{ name?: unknown; value?: unknown }>;
};

const ALT_MARKER = /\b(parallel|alternate art|alt art|manga)\b/i;

export function tcgcsvProductNumber(p: TcgcsvProduct): string | null {
  const field = (p.extendedData ?? []).find((e) => normName(String(e.name ?? "")) === "number");
  return typeof field?.value === "string" && field.value.trim() ? field.value.trim().slice(0, 64) : null;
}

/** Card name: the product name before " - ", "(" or "[". */
export function tcgcsvCardName(name: string): string {
  return normalizeTcgName(name.split(/ - |\(|\[/)[0] ?? "").slice(0, 200);
}

/** Set key from the group's abbreviation, else its name, in the catalog's key alphabet. */
export function tcgcsvSetKey(group: { name: string; abbreviation: string | null }): string | null {
  const source = group.abbreviation?.trim() || group.name;
  const key = source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9_-]*$/.test(key) ? key : null;
}

function conceptKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const lossless = /^[A-Za-z0-9\s'’.,:&!?()-]*$/.test(name);
  if (slug && lossless) return slug;
  const hash = createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 16);
  return slug ? `${slug}-${hash}` : `tcgcsv-${hash}`;
}

/** Variant keys a product's price sub-types stand for. */
export function variantsFor(productName: string, subTypes: string[]): string[] {
  if (ALT_MARKER.test(productName)) return subTypes.length > 0 ? ["parallel"] : [];
  const out = new Set<string>();
  for (const s of subTypes) {
    const n = normName(s);
    if (n === "normal" || n === "unlimited") out.add("normal");
    else if (n === "foil" || n === "holofoil") out.add("holofoil");
    else if (n === "reverseholofoil") out.add("reverse_holo");
  }
  return [...out];
}

/** Adds the group's cards to the catalog. Returns printings created and products skipped. */
export async function buildCatalogGroup(
  db: Database,
  group: { game_key: string; name: string; abbreviation: string | null },
  products: TcgcsvProduct[],
  prices: TcgcsvPriceRow[],
): Promise<{ printings: number; skipped: number }> {
  const setKey = tcgcsvSetKey(group);
  if (!setKey) return { printings: 0, skipped: products.length };
  const gameKey = group.game_key;
  const subTypes = new Map<number, string[]>();
  for (const row of prices) {
    const id = Number(row.productId);
    if (Number.isInteger(id) && typeof row.subTypeName === "string") subTypes.set(id, [...(subTypes.get(id) ?? []), row.subTypeName]);
  }
  type Card = { number: string; name: string; concept: string; variant: string };
  const cards: Card[] = [];
  let skipped = 0;
  for (const p of products) {
    const number = tcgcsvProductNumber(p);
    const name = tcgcsvCardName(String(p.name ?? ""));
    if (!number || !name || !Number.isInteger(Number(p.productId))) {
      skipped += 1;
      continue;
    }
    const variants = variantsFor(String(p.name), subTypes.get(Number(p.productId)) ?? []);
    if (variants.length === 0) skipped += 1;
    for (const variant of variants) cards.push({ number, name, concept: conceptKey(name), variant });
  }
  if (cards.length === 0) return { printings: 0, skipped };

  const setId = stableId("set", [gameKey, setKey]);
  await db.insert(tcgSet).values({ id: setId, gameKey, canonicalSetKey: setKey, name: group.name.slice(0, 200), languageScope: "en" }).onConflictDoNothing();
  const [set] = await db.select({ id: tcgSet.id }).from(tcgSet).where(and(eq(tcgSet.gameKey, gameKey), eq(tcgSet.canonicalSetKey, setKey))).limit(1);
  const concepts = new Map<string, typeof tcgCardConcept.$inferInsert>();
  for (const c of cards) {
    if (!concepts.has(c.concept))
      concepts.set(c.concept, { id: stableId("crd", [gameKey, c.concept]), gameKey, conceptKey: c.concept, canonicalName: c.name, normalizedName: normalizeTcgName(c.name) });
  }
  const conceptRows = [...concepts.values()];
  for (let i = 0; i < conceptRows.length; i += 1000) await db.insert(tcgCardConcept).values(conceptRows.slice(i, i + 1000)).onConflictDoNothing();
  const conceptIds = new Map<string, string>();
  const keys = [...concepts.keys()];
  for (let i = 0; i < keys.length; i += 1000) {
    for (const row of await db
      .select({ id: tcgCardConcept.id, key: tcgCardConcept.conceptKey })
      .from(tcgCardConcept)
      .where(and(eq(tcgCardConcept.gameKey, gameKey), inArray(tcgCardConcept.conceptKey, keys.slice(i, i + 1000))))) {
      conceptIds.set(row.key, row.id);
    }
  }
  const printings = new Map<string, typeof tcgPrinting.$inferInsert>();
  const identities = new Set<string>();
  for (const c of cards) {
    const cardId = conceptIds.get(c.concept);
    if (!cardId || !set) continue;
    const collectorNormalized = normalizeCollectorNumber(c.number);
    const identity = `${collectorNormalized}|${c.variant}`;
    // Two products on one number and variant: the catalog keeps the first, matching then sees both and links neither.
    if (identities.has(identity)) continue;
    identities.add(identity);
    const key = canonicalPrintingKey({ gameKey, conceptKey: c.concept, setKey, collectorNormalized, language: "en", variantKey: c.variant });
    printings.set(key, {
      id: stableId("prn", [key]),
      cardId,
      setId: set.id,
      gameKey,
      collectorNumber: c.number,
      collectorNumberNormalized: collectorNormalized,
      languageCode: "en",
      variantKey: c.variant,
      promo: false,
      canonicalPrintingKey: key,
      attributes: { source: "tcgcsv_catalog" },
    });
  }
  let created = 0;
  const rows = [...printings.values()];
  for (let i = 0; i < rows.length; i += 1000) {
    created += (await db.insert(tcgPrinting).values(rows.slice(i, i + 1000)).onConflictDoNothing().returning({ id: tcgPrinting.id })).length;
  }
  return { printings: created, skipped };
}
