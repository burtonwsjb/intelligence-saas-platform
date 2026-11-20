/**
 * Links Sentiment printings to TCGplayer products by reading tcgcsv.com's
 * card lists, game by game in the owner's order (tcgcsv-common.ts), so the
 * daily price step can price them. OFF unless TCGCSV_MATCH_ENABLED=1.
 *
 * Each run (hourly):
 * 1. last-updated.txt. Once per tcgcsv build: categories and each catalog
 *    game's groups (sets), saved in tcg_tcgplayer_group.
 * 2. Groups whose card list has not been read, or changed since (tcgcsv's
 *    modifiedOn), game order first, newest sets first: products + prices
 *    (2 requests each), at most TCGCSV_MATCH_GROUPS_PER_RUN (default 40)
 *    groups per run. A group with nothing to link costs nothing next time.
 * 3. Each unlinked English printing of the group's set is linked only when
 *    exactly one product fits: same collector number, same card name (before
 *    " - ", "(" or "["), parallel / alternate-art printings only to products
 *    marked as such and normal ones never to them, and a price sub-type that
 *    fits the printing's variant. Anything ambiguous is left unlinked.
 * Matching never writes prices; the daily step does. State: one
 * provider_sync_run row per build day (trigger `tcgcsv_match`).
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import {
  TCGCSV_GAME_ORDER,
  TCGCSV_CATALOG_GAMES,
  envFlag,
  envIds,
  envInt,
  errorReason,
  gameRank,
  insertDailyPrices,
  isTcgcsvCatalogGame,
  normName,
  pickTcgcsvRow,
  priceTimeForDay,
  rowsOf,
  saveTcgcsvRun,
  tcgcsvClient,
  tcgcsvRefusedRecently,
  utcDay,
  type TcgcsvPriceRow,
} from "./tcgcsv-common.js";
import { refreshTcgcsvCatalog } from "./tcgcsv-daily.js";
import { buildCatalogGroup } from "./tcgcsv-catalog.js";
import { createFetchTransport, type HttpTransport } from "./transport.js";

export const DEFAULT_TCGCSV_MATCH_GROUPS_PER_RUN = 40;
export const TCGCSV_MATCH_MAX_GROUPS_PER_RUN = 200;

export type TcgcsvMatchReport = {
  status: "completed" | "partial" | "stopped" | "skipped";
  reason: string | null;
  build: string | null;
  requests: number;
  groups: number;
  groupsLeft: number;
  candidates: number;
  linked: number;
  ambiguous: number;
  priced: number;
  cardsAdded: number;
  catalogCandidates: string[];
  byGame: Record<string, number>;
};

function emptyReport(): TcgcsvMatchReport {
  return { status: "completed", reason: null, build: null, requests: 0, groups: 0, groupsLeft: 0, candidates: 0, linked: 0, ambiguous: 0, priced: 0, cardsAdded: 0, catalogCandidates: [], byGame: {} };
}

export function tcgcsvMatchSettings(env: NodeJS.ProcessEnv) {
  return {
    enabled: envFlag(env.TCGCSV_MATCH_ENABLED),
    groupsPerRun: envInt(env.TCGCSV_MATCH_GROUPS_PER_RUN, DEFAULT_TCGCSV_MATCH_GROUPS_PER_RUN, 0, TCGCSV_MATCH_MAX_GROUPS_PER_RUN),
  };
}

/** Collector number for comparison: before "/", lowercase, no spaces, leading zeros dropped from each digit run. */
export function normNumber(value: string | null | undefined): string {
  return (value ?? "")
    .split("/")[0]!
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\d+/g, (d) => String(Number(d)));
}

/** Card name for comparison: the part before " - ", "(" or "[", normalized. */
export function baseName(value: string | null | undefined): string {
  return normName((value ?? "").split(/ - |\(|\[/)[0]);
}

const ALT_MARKER = /\b(parallel|alternate art|alt art|manga)\b/i;

function isAltVariant(variant: string) {
  return /parallel|alt/.test(variant);
}

const SUB_TYPES: Record<string, string[]> = {
  normal: ["Normal", "Unlimited", "1st Edition", "Limited"],
  holofoil: ["Holofoil", "Foil", "Unlimited Holofoil", "1st Edition Holofoil", "Limited Holofoil"],
  reverse_holo: ["Reverse Holofoil"],
};

/** The price sub-type that fits a printing's variant among the product's sub-types, or null. */
export function subTypeFor(variant: string, available: string[]): string | null {
  const prefs = SUB_TYPES[variant] ?? (isAltVariant(variant) ? [] : ["Foil", "Holofoil", "Normal"]);
  for (const want of prefs) {
    const hit = available.find((s) => normName(s) === normName(want));
    if (hit) return hit;
  }
  // A product with one price row and a variant that is not a finish of its own (normal, parallel): that row.
  if (available.length === 1 && (variant === "normal" || isAltVariant(variant))) return available[0]!;
  return null;
}

type Product = { productId?: unknown; name?: unknown; extendedData?: Array<{ name?: unknown; value?: unknown }> };

function productNumber(p: Product): string | null {
  const field = (p.extendedData ?? []).find((e) => normName(String(e.name ?? "")) === "number");
  return typeof field?.value === "string" && field.value.trim() ? field.value.trim() : null;
}

export type MatchCandidate = { printingId: string; collectorNumber: string; variant: string; name: string };

/** Picks the single product for each candidate; returns links and how many were ambiguous. */
export function matchGroup(candidates: MatchCandidate[], products: Product[], prices: TcgcsvPriceRow[]) {
  const subTypes = new Map<number, string[]>();
  for (const row of prices) {
    const id = Number(row.productId);
    if (!Number.isInteger(id) || typeof row.subTypeName !== "string") continue;
    subTypes.set(id, [...(subTypes.get(id) ?? []), row.subTypeName]);
  }
  const byNumber = new Map<string, Product[]>();
  for (const p of products) {
    const n = productNumber(p);
    if (!n || !Number.isInteger(Number(p.productId))) continue;
    const key = normNumber(n);
    byNumber.set(key, [...(byNumber.get(key) ?? []), p]);
  }
  const links: Array<{ printingId: string; productId: number; subType: string }> = [];
  let ambiguous = 0;
  for (const c of candidates) {
    const alt = isAltVariant(c.variant);
    const fits = (byNumber.get(normNumber(c.collectorNumber)) ?? []).filter((p) => {
      const name = String(p.name ?? "");
      return baseName(name) === normName(c.name) && ALT_MARKER.test(name) === alt;
    });
    const picks = fits
      .map((p) => ({ productId: Number(p.productId), subType: subTypeFor(c.variant, subTypes.get(Number(p.productId)) ?? []) }))
      .filter((p): p is { productId: number; subType: string } => p.subType != null);
    if (picks.length === 1) links.push({ printingId: c.printingId, ...picks[0]! });
    else if (fits.length > 0) ambiguous += 1;
  }
  return { links, ambiguous };
}

const SQL_NORM = (column: ReturnType<typeof sql.raw>) => sql`regexp_replace(lower(${column}), '[^a-z0-9]+', '', 'g')`;

/** Unlinked English printings of `game` in the set that `group` is (by key, name, or a set-prefixed number). */
async function candidatesFor(db: Database, group: { game_key: string; name: string; abbreviation: string | null }, prefixed: string[]) {
  const gname = normName(group.name);
  const abbr = normName(group.abbreviation);
  const setKey = SQL_NORM(sql.raw("s.canonical_set_key"));
  const setName = SQL_NORM(sql.raw("s.name"));
  const rows = rowsOf<{ id: string; collector_number: string; variant_key: string; canonical_name: string }>(
    await db.execute(sql`
      SELECT p.id, p.collector_number, p.variant_key, c.canonical_name
      FROM tcg_printing p
      JOIN tcg_set s ON s.id = p.set_id
      JOIN tcg_card_concept c ON c.id = p.card_id
      WHERE p.game_key = ${group.game_key} AND p.language_code = 'en' AND p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM tcg_tcgplayer_link l WHERE l.printing_id = p.id)
        AND (
          (${abbr} <> '' AND ${setKey} = ${abbr})
          OR ${setName} = ${gname}
          OR (length(${setName}) >= 6 AND position(${setName} IN ${gname}) > 0)
          ${prefixed.length > 0 ? sql`OR upper(p.collector_number) IN (${sql.join(prefixed.map((n) => sql`${n}`), sql`, `)})` : sql``}
        )`),
  );
  return rows.map((r) => ({ printingId: r.id, collectorNumber: r.collector_number, variant: r.variant_key, name: r.canonical_name }));
}

async function priceGroupFromFile(db: Database, groupId: number, rows: TcgcsvPriceRow[], build: string): Promise<number> {
  const links = rowsOf<{ printing_id: string; product_id: number; sub_type: string }>(
    await db.execute(sql`SELECT printing_id, product_id, sub_type FROM tcg_tcgplayer_link WHERE group_id = ${groupId}`),
  );
  const observedAt = priceTimeForDay(utcDay(build));
  const prices = [];
  for (const link of links) {
    const point = pickTcgcsvRow(rows, { productId: Number(link.product_id), subType: link.sub_type });
    if (point) prices.push({ printingId: link.printing_id, observedAt, ...point, source: "daily" as const });
  }
  const written = await insertDailyPrices(db, prices);
  await db.execute(sql`UPDATE tcg_tcgplayer_group SET prices_build = ${build}, updated_at = now() WHERE group_id = ${groupId}`);
  return written;
}

async function catalogGames(db: Database): Promise<string[]> {
  const rows = rowsOf<{ game_key: string }>(
    await db.execute(sql`SELECT DISTINCT game_key FROM tcg_printing WHERE language_code = 'en' AND status = 'active'`),
  );
  return rows.map((r) => r.game_key).sort((a, b) => gameRank(a) - gameRank(b));
}

/** The worker's matching step (see the file comment). */
export async function syncTcgcsvMatch(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date; sleep?: (ms: number) => Promise<void>; spacingMs?: number } = {},
): Promise<TcgcsvMatchReport> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const settings = tcgcsvMatchSettings(env);
  if (!settings.enabled || settings.groupsPerRun === 0) return { ...emptyReport(), status: "skipped", reason: "disabled" };

  return withPlatformContext(db, async (tx) => {
    const lock = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcgcsv.v1')) as locked`));
    if (!lock[0]?.locked) return { ...emptyReport(), status: "skipped" as const, reason: "overlap" };
    if (await tcgcsvRefusedRecently(tx, now)) return { ...emptyReport(), status: "skipped" as const, reason: "refused_recently" };
    const catalogCategoryIds = envIds(env.TCGCSV_CATALOG_CATEGORY_IDS);
    // Games built from tcgcsv's own card lists join as soon as one of their categories is picked.
    const games = [...new Set([...(await catalogGames(tx)), ...(catalogCategoryIds.length > 0 ? TCGCSV_CATALOG_GAMES : [])])]
      .filter((g) => (TCGCSV_GAME_ORDER as readonly string[]).includes(g))
      .sort((a, b) => gameRank(a) - gameRank(b));
    if (games.length === 0) return { ...emptyReport(), status: "skipped" as const, reason: "no_catalog" };

    const report = emptyReport();
    const client = tcgcsvClient({
      transport: input.transport ?? createFetchTransport({ timeoutMs: 30_000 }),
      maxRequests: 2 * settings.groupsPerRun + 2 + 4 * TCGCSV_GAME_ORDER.length,
      sleep: input.sleep,
      spacingMs: input.spacingMs,
    });
    let day = utcDay(now);
    let checkpoint: Record<string, unknown> = {};
    try {
      const build = await client.lastUpdated();
      report.build = build;
      day = utcDay(build);
      const state = rowsOf<{ checkpoint: Record<string, unknown> | string | null }>(
        await tx.execute(sql`SELECT checkpoint FROM provider_sync_run WHERE id = ${`tcgcsv_match_${day}`}`),
      )[0];
      checkpoint = typeof state?.checkpoint === "string" ? JSON.parse(state.checkpoint) : (state?.checkpoint ?? {});
      if (checkpoint.catalog_build !== build) {
        await refreshTcgcsvCatalog(tx, client, games, {
          catalogCategoryIds,
          onCatalogCandidates: (candidates) => {
            report.catalogCandidates = candidates;
            checkpoint.catalog_candidates = candidates;
          },
        });
        checkpoint.catalog_build = build;
      }
      const due = rowsOf<{ group_id: number; category_id: number; game_key: string; name: string; abbreviation: string | null; modified_on: string | null }>(
        await tx.execute(sql`
          SELECT group_id, category_id, game_key, name, abbreviation, modified_on FROM tcg_tcgplayer_group
          WHERE products_scanned_at IS NULL OR products_modified_on IS DISTINCT FROM modified_on`),
      )
        .filter((g) => games.includes(g.game_key))
        .sort((a, b) => gameRank(a.game_key) - gameRank(b.game_key) || String(b.modified_on ?? "").localeCompare(String(a.modified_on ?? "")));
      const take = due.slice(0, settings.groupsPerRun);
      report.groupsLeft = due.length - take.length;
      for (const group of take) {
        const products = await client.getList<Product>(`${group.category_id}/${group.group_id}/products`);
        const prefixed = [
          ...new Set(
            products
              .map(productNumber)
              .filter((n): n is string => n != null && /^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$/.test(n))
              .map((n) => n.toUpperCase()),
          ),
        ];
        let prices: TcgcsvPriceRow[] | null = null;
        if (isTcgcsvCatalogGame(group.game_key)) {
          prices = await client.getList<TcgcsvPriceRow>(`${group.category_id}/${group.group_id}/prices`);
          const built = await buildCatalogGroup(tx, group, products, prices);
          report.cardsAdded += built.printings;
        }
        const candidates = await candidatesFor(tx, group, prefixed);
        report.candidates += candidates.length;
        if (candidates.length > 0) {
          prices ??= await client.getList<TcgcsvPriceRow>(`${group.category_id}/${group.group_id}/prices`);
          const { links, ambiguous } = matchGroup(candidates, products, prices);
          report.ambiguous += ambiguous;
          for (let i = 0; i < links.length; i += 500) {
            await tx.execute(sql`
              INSERT INTO tcg_tcgplayer_link (printing_id, category_id, group_id, group_name, product_id, sub_type, method, matched_at)
              VALUES ${sql.join(
                links
                  .slice(i, i + 500)
                  .map((l) => sql`(${l.printingId}, ${group.category_id}, ${group.group_id}, ${group.name}, ${l.productId}, ${l.subType}, 'number_match', ${now.toISOString()}::timestamptz)`),
                sql`, `,
              )}
              ON CONFLICT (printing_id) DO NOTHING`);
          }
          report.linked += links.length;
          report.byGame[group.game_key] = (report.byGame[group.game_key] ?? 0) + links.length;
          // The price file was just read for this build: price the group's links from it so the daily step
          // never asks tcgcsv for the same file twice in a day.
          report.priced += await priceGroupFromFile(tx, group.group_id, prices, build);
        }
        await tx.execute(sql`
          UPDATE tcg_tcgplayer_group SET products_scanned_at = ${now.toISOString()}::timestamptz, products_modified_on = modified_on
          WHERE group_id = ${group.group_id}`);
        report.groups += 1;
      }
      report.status = report.groupsLeft > 0 ? "partial" : "completed";
    } catch (error) {
      report.status = "stopped";
      report.reason = errorReason(error);
    }
    report.requests = client.state.requests;
    await saveTcgcsvRun(tx, {
      id: `tcgcsv_match_${day}`,
      trigger: "tcgcsv_match",
      status: report.status === "stopped" ? "failed" : "completed",
      now,
      received: report.linked,
      errorClass: report.status === "stopped" ? report.reason : null,
      checkpoint: {
        ...checkpoint,
        ...report,
        requests: Number(checkpoint.requests ?? 0) + report.requests,
        linked_total: Number(checkpoint.linked_total ?? 0) + report.linked,
        refused: report.reason?.startsWith("refused_") ?? false,
      },
    });
    return report;
  });
}
