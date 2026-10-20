import { inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { tcgPrintingImage } from "../schema/tcg.js";

/**
 * Card pictures come from TCG Card Central's catalog feed and are stored on
 * the printing as attributes.image_url. Only absolute https URLs without
 * spaces or quote characters are kept, both when importing and when reading,
 * so a page never renders a path, a data: URL or an http image.
 */
const IMAGE_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[^\s"'<>\\]*$/i;
const IMAGE_URL_MAX = 1000;

export function safeCardImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return url.length <= IMAGE_URL_MAX && IMAGE_URL.test(url) ? url : null;
}

/**
 * Pictures for these printings, keyed by printing id. Reads run in a savepoint
 * and a failure (a database where migration 0037 has not run yet) returns no
 * pictures, so pages fall back to the placeholder instead of failing.
 */
export async function loadPrintingImages(db: Database, printingIds: string[]): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const ids = [...new Set(printingIds)];
  if (ids.length === 0) return images;
  try {
    const rows = await db.transaction((tx) =>
      tx
        .select({ printingId: tcgPrintingImage.printingId, imageUrl: tcgPrintingImage.imageUrl })
        .from(tcgPrintingImage)
        .where(inArray(tcgPrintingImage.printingId, ids)),
    );
    for (const row of rows) {
      const url = safeCardImageUrl(row.imageUrl);
      if (url) images.set(row.printingId, url);
    }
  } catch {
    images.clear();
  }
  return images;
}

export type CardImagePick = { key: string; gameKey: string; cardName: string; setName?: string };
export type PickedCardImage = { imageUrl: string; cardName: string; setName: string };

/**
 * One picture per pick, for showcase spots such as the landing page: an exact
 * card name (any case) in that game, optionally within a set whose name
 * contains setName. English printings and newer sets come first. Picks with
 * no picture are left out, and any failure returns none.
 */
export async function findCardImages(db: Database, picks: CardImagePick[]): Promise<Map<string, PickedCardImage>> {
  const found = new Map<string, PickedCardImage>();
  if (picks.length === 0) return found;
  const values = sql.join(
    picks.map((pick) => sql`(${pick.key}, ${pick.gameKey}, ${pick.cardName}, ${pick.setName ?? ""})`),
    sql`, `,
  );
  try {
    const rows = await db.transaction((tx) =>
      tx.execute(sql`
        SELECT DISTINCT ON (v.key) v.key, img.image_url, c.canonical_name AS card_name, st.name AS set_name
        FROM (VALUES ${values}) AS v(key, game_key, card_name, set_name)
        JOIN tcg_card_concept c ON c.game_key = v.game_key AND lower(c.canonical_name) = lower(v.card_name)
        JOIN tcg_printing p ON p.card_id = c.id AND p.status = 'active'
        JOIN tcg_set st ON st.id = p.set_id
        JOIN tcg_printing_image img ON img.printing_id = p.id
        WHERE v.set_name = '' OR st.name ILIKE '%' || v.set_name || '%'
        ORDER BY v.key, (p.language_code = 'en') DESC, st.release_date DESC NULLS LAST, p.id
      `),
    );
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    for (const row of list as Record<string, unknown>[]) {
      const url = safeCardImageUrl(row.image_url);
      if (url) found.set(String(row.key), { imageUrl: url, cardName: String(row.card_name), setName: String(row.set_name) });
    }
  } catch {
    found.clear();
  }
  return found;
}
