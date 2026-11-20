/**
 * Daily TCGplayer market prices straight from tcgcsv.com for every printing
 * linked to a TCGplayer product (tcg_tcgplayer_link), every game, in the
 * owner's game order. OFF unless TCGCSV_DAILY_ENABLED=1.
 *
 * Why: TCG Card Central's feed answers "price source unavailable" since
 * 2026-11-09 (tcgcsv refuses its server). tcgcsv's FAQ: permission is
 * implicit for clients that follow its usage guidelines (tcgcsv-common.ts).
 *
 * Each run (hourly, from TCGCSV_DAILY_START_UTC_HOUR, default 21):
 * 1. last-updated.txt: nothing more happens unless tcgcsv has a build newer
 *    than the last fully pulled one.
 * 2. Once per build: categories (1 request) and each linked game's groups
 *    (1 per category), saved in tcg_tcgplayer_group; links that only know
 *    their set's name get its group id.
 * 3. One price file per linked group not yet pulled for this build, game
 *    order first, at most TCGCSV_DAILY_GROUPS_PER_RUN (default 600) per run;
 *    the rest continue next run. Each linked printing's market price lands
 *    in tcg_daily_price for the build's day (stamped 20:00 UTC).
 * The build counts as done when no linked group is left. The daily price
 * archive is never used here (tcgcsv may ban clients that download archives
 * day after day). State: one provider_sync_run row per build day (trigger
 * `tcgcsv_daily`, id `tcgcsv_daily_<day>`).
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import {
  TCGCSV_GAME_ORDER,
  envFlag,
  envInt,
  errorReason,
  gameForCategory,
  gameRank,
  insertDailyPrices,
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
import { createFetchTransport, type HttpTransport } from "./transport.js";

export { TCGCSV_SKIPPED_CATEGORIES, TCGCSV_USER_AGENT, pickTcgcsvRow } from "./tcgcsv-common.js";

export const TCGCSV_DAILY_TRIGGER = "tcgcsv_daily";
export const DEFAULT_TCGCSV_DAILY_START_UTC_HOUR = 21;
export const DEFAULT_TCGCSV_DAILY_GROUPS_PER_RUN = 600;
export const TCGCSV_DAILY_MAX_GROUPS_PER_RUN = 2_000;

export type TcgcsvDailyReport = {
  status: "completed" | "partial" | "stopped" | "skipped";
  reason: string | null;
  build: string | null;
  requests: number;
  groups: number;
  groupsLeft: number;
  linked: number;
  priced: number;
  missing: number;
  written: number;
  linksResolved: number;
};

export function emptyTcgcsvReport(): TcgcsvDailyReport {
  return { status: "completed", reason: null, build: null, requests: 0, groups: 0, groupsLeft: 0, linked: 0, priced: 0, missing: 0, written: 0, linksResolved: 0 };
}

export function tcgcsvDailySettings(env: NodeJS.ProcessEnv) {
  return {
    enabled: envFlag(env.TCGCSV_DAILY_ENABLED),
    startHour: envInt(env.TCGCSV_DAILY_START_UTC_HOUR, DEFAULT_TCGCSV_DAILY_START_UTC_HOUR, 0, 23),
    groupsPerRun: envInt(env.TCGCSV_DAILY_GROUPS_PER_RUN, DEFAULT_TCGCSV_DAILY_GROUPS_PER_RUN, 0, TCGCSV_DAILY_MAX_GROUPS_PER_RUN),
  };
}

type State = { id: string; status: string; checkpoint: Record<string, unknown> | string | null };

function checkpointOf(row: State | undefined): Record<string, unknown> {
  if (!row?.checkpoint) return {};
  return typeof row.checkpoint === "string" ? (JSON.parse(row.checkpoint) as Record<string, unknown>) : row.checkpoint;
}

/** The build saved with the last fully pulled day, if any. */
async function lastDoneBuild(db: Database): Promise<string | null> {
  const rows = rowsOf<{ build: string | null }>(
    await db.execute(sql`
      SELECT checkpoint->>'build' AS build FROM provider_sync_run
      WHERE provider_key = 'tcgplayer' AND "trigger" = ${TCGCSV_DAILY_TRIGGER} AND status = 'completed'
        AND checkpoint->>'build' IS NOT NULL
      ORDER BY checkpoint->>'build' DESC LIMIT 1`),
  );
  return rows[0]?.build ?? null;
}

/** Games that have at least one linked printing, in the owner's order. */
export async function linkedGames(db: Database): Promise<string[]> {
  const rows = rowsOf<{ game_key: string }>(
    await db.execute(sql`SELECT DISTINCT p.game_key FROM tcg_tcgplayer_link l JOIN tcg_printing p ON p.id = l.printing_id`),
  );
  return rows.map((r) => r.game_key).sort((a, b) => gameRank(a) - gameRank(b));
}

/**
 * Saves tcgcsv's categories and groups for `games` and gives links that only
 * know their set's name the group id (exact normalized name within the
 * link's game; a name shared by two groups is left alone).
 */
export async function refreshTcgcsvCatalog(db: Database, client: ReturnType<typeof tcgcsvClient>, games: string[]): Promise<number> {
  const categories = await client.getList<{ categoryId?: unknown; name?: unknown; displayName?: unknown }>("categories");
  const wanted = categories
    .map((c) => ({ id: Number(c.categoryId), game: gameForCategory(c) }))
    .filter((c): c is { id: number; game: string } => c.game != null && games.includes(c.game))
    .sort((a, b) => gameRank(a.game) - gameRank(b.game));
  for (const category of wanted) {
    const groups = await client.getList<{ groupId?: unknown; name?: unknown; abbreviation?: unknown; modifiedOn?: unknown }>(
      `${category.id}/groups`,
    );
    const rows = groups.filter((g) => Number.isInteger(Number(g.groupId)) && typeof g.name === "string");
    for (let i = 0; i < rows.length; i += 500) {
      await db.execute(sql`
        INSERT INTO tcg_tcgplayer_group (group_id, category_id, game_key, name, abbreviation, modified_on, updated_at)
        VALUES ${sql.join(
          rows.slice(i, i + 500).map(
            (g) =>
              sql`(${Number(g.groupId)}, ${category.id}, ${category.game}, ${String(g.name)}, ${typeof g.abbreviation === "string" ? g.abbreviation : null}, ${typeof g.modifiedOn === "string" ? g.modifiedOn : null}, now())`,
          ),
          sql`, `,
        )}
        ON CONFLICT (group_id) DO UPDATE SET category_id = EXCLUDED.category_id, game_key = EXCLUDED.game_key,
          name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation, modified_on = EXCLUDED.modified_on, updated_at = now()`);
    }
  }
  const pending = rowsOf<{ printing_id: string; game_key: string; group_name: string }>(
    await db.execute(sql`
      SELECT l.printing_id, p.game_key, l.group_name FROM tcg_tcgplayer_link l
      JOIN tcg_printing p ON p.id = l.printing_id
      WHERE l.group_id IS NULL AND l.group_name IS NOT NULL`),
  );
  if (pending.length === 0) return 0;
  const groups = rowsOf<{ group_id: number; category_id: number; game_key: string; name: string }>(
    await db.execute(sql`SELECT group_id, category_id, game_key, name FROM tcg_tcgplayer_group`),
  );
  const byName = new Map<string, Array<{ group_id: number; category_id: number }>>();
  for (const g of groups) {
    const key = `${g.game_key}|${normName(g.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), { group_id: Number(g.group_id), category_id: Number(g.category_id) }]);
  }
  let resolved = 0;
  for (const link of pending) {
    const hits = byName.get(`${link.game_key}|${normName(link.group_name)}`) ?? [];
    if (hits.length !== 1) continue;
    await db.execute(sql`
      UPDATE tcg_tcgplayer_link SET group_id = ${hits[0]!.group_id}, category_id = ${hits[0]!.category_id}
      WHERE printing_id = ${link.printing_id} AND group_id IS NULL`);
    resolved += 1;
  }
  return resolved;
}

/**
 * The worker's daily tcgcsv step (see the file comment). Gated by
 * TCGCSV_DAILY_ENABLED, the start hour, a week's pause after any refusal,
 * and an advisory lock so two replicas never both fetch.
 */
export async function syncTcgcsvDaily(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date; sleep?: (ms: number) => Promise<void>; spacingMs?: number } = {},
): Promise<TcgcsvDailyReport> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const settings = tcgcsvDailySettings(env);
  if (!settings.enabled || settings.groupsPerRun === 0) return { ...emptyTcgcsvReport(), status: "skipped", reason: "disabled" };
  if (now.getUTCHours() < settings.startHour) return { ...emptyTcgcsvReport(), status: "skipped", reason: "before_start_hour" };

  return withPlatformContext(db, async (tx) => {
    const lock = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcgcsv.v1')) as locked`));
    if (!lock[0]?.locked) return { ...emptyTcgcsvReport(), status: "skipped" as const, reason: "overlap" };
    if (await tcgcsvRefusedRecently(tx, now)) return { ...emptyTcgcsvReport(), status: "skipped" as const, reason: "refused_recently" };
    const games = await linkedGames(tx);
    if (games.length === 0) return { ...emptyTcgcsvReport(), status: "skipped" as const, reason: "nothing_linked" };

    const report = emptyTcgcsvReport();
    const client = tcgcsvClient({
      transport: input.transport ?? createFetchTransport({ timeoutMs: 30_000 }),
      // last-updated + categories + one groups list per category + price files
      maxRequests: settings.groupsPerRun + 2 + 4 * TCGCSV_GAME_ORDER.length,
      sleep: input.sleep,
      spacingMs: input.spacingMs,
    });
    let day: string | null = null;
    let checkpoint: Record<string, unknown> = {};
    try {
      const build = await client.lastUpdated();
      report.build = build;
      const done = await lastDoneBuild(tx);
      if (done && Date.parse(build) <= Date.parse(done)) {
        return { ...report, status: "skipped" as const, reason: "no_new_build", requests: client.state.requests };
      }
      day = utcDay(build);
      checkpoint = checkpointOf(
        rowsOf<State>(await tx.execute(sql`SELECT id, status, checkpoint FROM provider_sync_run WHERE id = ${`tcgcsv_daily_${day}`}`))[0],
      );
      if (checkpoint.catalog_build !== build) {
        report.linksResolved = await refreshTcgcsvCatalog(tx, client, games);
        checkpoint.catalog_build = build;
      }
      const due = rowsOf<{ group_id: number; category_id: number; game_key: string }>(
        await tx.execute(sql`
          SELECT DISTINCT g.group_id, g.category_id, g.game_key
          FROM tcg_tcgplayer_link l JOIN tcg_tcgplayer_group g ON g.group_id = l.group_id
          WHERE g.prices_build IS DISTINCT FROM ${build}`),
      ).sort((a, b) => gameRank(a.game_key) - gameRank(b.game_key) || Number(a.group_id) - Number(b.group_id));
      const take = due.slice(0, settings.groupsPerRun);
      report.groupsLeft = due.length - take.length;
      const observedAt = priceTimeForDay(day);
      for (const group of take) {
        const rows = await client.getList<TcgcsvPriceRow>(`${group.category_id}/${group.group_id}/prices`);
        report.groups += 1;
        const links = rowsOf<{ printing_id: string; product_id: number; sub_type: string }>(
          await tx.execute(sql`SELECT printing_id, product_id, sub_type FROM tcg_tcgplayer_link WHERE group_id = ${group.group_id}`),
        );
        report.linked += links.length;
        const prices = [];
        for (const link of links) {
          const point = pickTcgcsvRow(rows, { productId: Number(link.product_id), subType: link.sub_type });
          if (!point) {
            report.missing += 1;
            continue;
          }
          report.priced += 1;
          prices.push({ printingId: link.printing_id, observedAt, ...point, source: "daily" as const });
        }
        report.written += await insertDailyPrices(tx, prices);
        await tx.execute(sql`UPDATE tcg_tcgplayer_group SET prices_build = ${build}, updated_at = now() WHERE group_id = ${group.group_id}`);
      }
      report.status = report.groupsLeft > 0 ? "partial" : "completed";
    } catch (error) {
      report.status = "stopped";
      report.reason = errorReason(error);
    }
    report.requests = client.state.requests;
    const refused = report.reason?.startsWith("refused_") ?? false;
    const previous = Number(checkpoint.requests ?? 0);
    await saveTcgcsvRun(tx, {
      id: `tcgcsv_daily_${day ?? utcDay(now)}`,
      trigger: "tcgcsv_daily",
      status: report.status === "completed" ? "completed" : "failed",
      now,
      received: report.written,
      errorClass: report.status === "completed" || report.status === "partial" ? null : report.reason,
      checkpoint: { ...checkpoint, ...report, requests: previous + report.requests, refused },
    });
    return report;
  });
}
