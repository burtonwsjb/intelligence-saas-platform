/**
 * Today's TCGplayer market price for every English Pokemon / One Piece
 * printing whose TCGplayer product is already known, read straight from
 * tcgcsv.com's daily price files. OFF unless TCGCSV_DAILY_ENABLED=1.
 *
 * Why: TCG Card Central's feed (tcc-quotes / tcc-price-history) answers
 * "price source unavailable" because tcgcsv refuses its server. Sentiment
 * already stored each printing's TCGplayer product id, group name and
 * sub-type from earlier TCC answers, so it can read the same public price
 * files itself. Switch it on only once tcgcsv has said that is fine.
 *
 * tcgcsv's usage guidelines, followed here:
 * - A clear User-Agent naming the app and a way to reach us.
 * - Requests spaced (1 s here; tcgcsv asks for about 100 ms).
 * - Data cached: tcgcsv updates once a day, so this runs at most once per
 *   UTC day, after TCGCSV_DAILY_START_UTC_HOUR (default 21), and only when
 *   https://tcgcsv.com/last-updated.txt shows a build newer than the last
 *   pull (one small request per hourly check until then). One price file
 *   per set; the daily price archive is never used for this (tcgcsv may ban
 *   clients that download archives day after day).
 * - Far under the 10,000 requests a day that may be banned: one categories
 *   request, one groups request per game, then one price file per set
 *   (about 500), hard capped at TCGCSV_DAILY_MAX_REQUESTS (default 1,000,
 *   never above 5,000).
 * - A 401/403/429 stops the run at once and the step waits
 *   TCGCSV_REFUSED_PAUSE_DAYS (7) before trying a single run again.
 *
 * Writes one tcg_market_snapshot reference price per printing and day
 * (source `tcgplayer`, record id `tcgcsv:daily:<printingId>:<date>`).
 * State: one provider_sync_run row per day (provider tcgplayer, trigger
 * `tcgcsv_daily`, id `tcgcsv_daily_<date>`).
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { ingestTcgMarketRecordsBatch } from "../tcg/market-ingest.js";
import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import { createFetchTransport, type HttpTransport } from "./transport.js";

export const TCGCSV_BASE = "https://tcgcsv.com/tcgplayer";
export const TCGCSV_LAST_UPDATED_URL = "https://tcgcsv.com/last-updated.txt";
export const TCGCSV_USER_AGENT = "TCGSentiment/1.0 (+https://tcgsentiment.com)";
export const TCGCSV_DAILY_TRIGGER = "tcgcsv_daily";
export const TCGCSV_DAILY_SPACING_MS = 1_000;
export const DEFAULT_TCGCSV_DAILY_MAX_REQUESTS = 1_000;
export const TCGCSV_DAILY_HARD_MAX_REQUESTS = 5_000;
export const DEFAULT_TCGCSV_DAILY_START_UTC_HOUR = 21;
export const TCGCSV_REFUSED_PAUSE_DAYS = 7;
/** tcgcsv category names (normalized) per Sentiment game. Exact, so "Pokemon Japan" is never read. */
export const TCGCSV_CATEGORY_NAMES: Record<string, string> = { pokemon: "pokemon", one_piece: "onepiececardgame" };

/** Categories tcgcsv asks every client to skip (empty or retired), never read. */
export const TCGCSV_SKIPPED_CATEGORIES = new Set([9, 10, 12, 14, 21, 55, 69, 70]);

const DAY_MS = 86_400_000;

export type TcgcsvTarget = {
  printingId: string;
  game: string;
  setKey: string;
  collectorNumber: string;
  language: string;
  variant: string;
  productId: number;
  groupName: string;
  subType: string;
};

type TcgcsvPriceRow = {
  productId?: unknown;
  subTypeName?: unknown;
  marketPrice?: unknown;
  lowPrice?: unknown;
  midPrice?: unknown;
  highPrice?: unknown;
};

export type TcgcsvDailyReport = {
  status: "completed" | "stopped" | "skipped";
  reason: string | null;
  targets: number;
  groups: number;
  requests: number;
  priced: number;
  missing: number;
  unmatchedGroups: number;
  written: number;
  /** tcgcsv build (last-updated.txt) this pull read. */
  build?: string;
};

export function emptyTcgcsvReport(): TcgcsvDailyReport {
  return { status: "completed", reason: null, targets: 0, groups: 0, requests: 0, priced: 0, missing: 0, unmatchedGroups: 0, written: 0 };
}

export function normTcgcsvName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function envFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function envInt(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && value?.trim() ? Math.floor(n) : fallback;
}

export function tcgcsvDailyMaxRequests(env: NodeJS.ProcessEnv): number {
  const n = envInt(env.TCGCSV_DAILY_MAX_REQUESTS, DEFAULT_TCGCSV_DAILY_MAX_REQUESTS);
  return Math.max(0, Math.min(n, TCGCSV_DAILY_HARD_MAX_REQUESTS));
}

export function tcgcsvDailyStartHour(env: NodeJS.ProcessEnv): number {
  const n = envInt(env.TCGCSV_DAILY_START_UTC_HOUR, DEFAULT_TCGCSV_DAILY_START_UTC_HOUR);
  return Math.max(0, Math.min(n, 23));
}

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

export function tcgcsvDailyRecordId(printingId: string, day: string) {
  return `tcgcsv:daily:${printingId}:${day}`;
}

function price(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The price row for the printing's own product and sub-type, with a market price; null otherwise. */
export function pickTcgcsvRow(rows: TcgcsvPriceRow[], target: Pick<TcgcsvTarget, "productId" | "subType">) {
  const want = normTcgcsvName(target.subType);
  const row = rows.find(
    (r) => Number(r.productId) === target.productId && typeof r.subTypeName === "string" && normTcgcsvName(r.subTypeName) === want,
  );
  const market = row ? price(row.marketPrice) : null;
  if (!row || market == null) return null;
  return { market, low: price(row.lowPrice), mid: price(row.midPrice), high: price(row.highPrice) };
}

export function tcgcsvRecord(
  target: TcgcsvTarget,
  day: string,
  observedAt: Date,
  point: { market: number; low: number | null; mid: number | null; high: number | null },
): TcgMarketRecordInput {
  return {
    provider: "tcgplayer",
    provider_record_id: tcgcsvDailyRecordId(target.printingId, day),
    event_type: "tcg.market.reference_price",
    market_type: "market_price",
    price_type: "reference",
    observed_at: observedAt.toISOString(),
    currency: "USD",
    condition: "unknown",
    raw_condition: "product_level",
    price: point.market,
    low_price: point.low,
    high_price: point.high,
    median_price: point.mid,
    source_reference: `tcgplayer:${target.productId}`,
    printing: {
      game: target.game,
      set: target.setKey,
      collector_number: target.collectorNumber,
      language: target.language,
      variant: target.variant,
    },
    attributes: {
      tcgplayer_product_id: target.productId,
      tcgplayer_group_name: target.groupName,
      tcgplayer_sub_type: target.subType,
      price_source: "tcgplayer_market_via_tcgcsv",
    },
  };
}

class TcgcsvRefused extends Error {
  constructor(readonly status: number) {
    super(`tcgcsv refused (HTTP ${status})`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads today's price files for the targets' sets and returns one record per
 * printing that has a market price. No database access. Stops at the first
 * refusal (401/403/429) or when `maxRequests` would be passed.
 */
export async function collectTcgcsvDaily(input: {
  targets: TcgcsvTarget[];
  transport?: HttpTransport;
  now?: Date;
  maxRequests: number;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}): Promise<{ report: TcgcsvDailyReport; records: TcgMarketRecordInput[] }> {
  const report = emptyTcgcsvReport();
  const records: TcgMarketRecordInput[] = [];
  const now = input.now ?? new Date();
  const day = utcDay(now);
  report.targets = input.targets.length;
  if (input.targets.length === 0) return { report: { ...report, status: "skipped", reason: "nothing_to_price" }, records };
  const transport = input.transport ?? createFetchTransport({ timeoutMs: 30_000 });
  const sleep = input.sleep ?? defaultSleep;
  const spacing = Math.max(input.spacingMs ?? TCGCSV_DAILY_SPACING_MS, 0);

  async function get<T>(path: string): Promise<T[]> {
    if (report.requests >= input.maxRequests) throw new Error("request_cap");
    if (report.requests > 0 && spacing > 0) await sleep(spacing);
    report.requests += 1;
    const response = await transport.fetch(`${TCGCSV_BASE}/${path}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": TCGCSV_USER_AGENT },
    });
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new TcgcsvRefused(response.status);
    if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
    const body = JSON.parse(response.bodyText) as { results?: unknown };
    if (!body || !Array.isArray(body.results)) throw new Error("invalid_payload");
    return body.results as T[];
  }

  try {
    const categories = await get<{ categoryId?: unknown; name?: unknown }>("categories");
    const byGame = new Map<string, TcgcsvTarget[]>();
    for (const target of input.targets) byGame.set(target.game, [...(byGame.get(target.game) ?? []), target]);
    for (const [game, targets] of byGame) {
      const want = TCGCSV_CATEGORY_NAMES[game];
      const category = categories.find(
        (c) => typeof c.name === "string" && normTcgcsvName(c.name) === want && !TCGCSV_SKIPPED_CATEGORIES.has(Number(c.categoryId)),
      );
      if (!want || !category) {
        report.missing += targets.length;
        continue;
      }
      const categoryId = Number(category.categoryId);
      const groups = await get<{ groupId?: unknown; name?: unknown }>(`${categoryId}/groups`);
      const groupIds = new Map<string, number>();
      for (const g of groups) if (typeof g.name === "string") groupIds.set(normTcgcsvName(g.name), Number(g.groupId));
      const bySet = new Map<string, TcgcsvTarget[]>();
      for (const target of targets) {
        const key = normTcgcsvName(target.groupName);
        bySet.set(key, [...(bySet.get(key) ?? []), target]);
      }
      for (const [key, setTargets] of bySet) {
        const groupId = groupIds.get(key);
        if (groupId == null) {
          report.unmatchedGroups += 1;
          report.missing += setTargets.length;
          continue;
        }
        report.groups += 1;
        const rows = await get<TcgcsvPriceRow>(`${categoryId}/${groupId}/prices`);
        for (const target of setTargets) {
          const point = pickTcgcsvRow(rows, target);
          if (!point) {
            report.missing += 1;
            continue;
          }
          report.priced += 1;
          records.push(tcgcsvRecord(target, day, now, point));
        }
      }
    }
  } catch (error) {
    report.status = "stopped";
    report.reason =
      error instanceof TcgcsvRefused ? `refused_${error.status}` : error instanceof Error ? error.message.slice(0, 80) : "failed";
  }
  return { report, records };
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/**
 * English Pokemon / One Piece printings with a TCGplayer product id, group
 * name and sub-type from their latest stored TCGplayer price, minus those
 * already priced from tcgcsv today.
 */
export async function listTcgcsvTargets(db: Database, now = new Date()): Promise<TcgcsvTarget[]> {
  const day = utcDay(now);
  const rows = rowsOf<{
    printing_id: string;
    game_key: string;
    set_key: string;
    collector_number: string;
    language_code: string;
    variant_key: string;
    product_id: string | number;
    group_name: string;
    sub_type: string;
  }>(
    await db.execute(sql`
      SELECT DISTINCT ON (s.printing_id)
        s.printing_id, p.game_key, ts.canonical_set_key AS set_key, p.collector_number,
        p.language_code, p.variant_key,
        s.attributes->>'tcgplayer_product_id' AS product_id,
        s.attributes->>'tcgplayer_group_name' AS group_name,
        s.attributes->>'tcgplayer_sub_type' AS sub_type
      FROM tcg_market_snapshot s
      JOIN tcg_printing p ON p.id = s.printing_id
      JOIN tcg_set ts ON ts.id = p.set_id
      WHERE s.source_key IN ('tcg_card_central', 'tcgplayer')
        AND s.price_type = 'reference'
        AND p.game_key IN ('pokemon', 'one_piece')
        AND p.language_code = 'en'
        AND s.attributes->>'tcgplayer_product_id' ~ '^[0-9]+$'
        AND coalesce(s.attributes->>'tcgplayer_group_name', '') <> ''
        AND coalesce(s.attributes->>'tcgplayer_sub_type', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM tcg_market_ingest i
          WHERE i.source_key = 'tcgplayer'
            AND i.source_record_id = 'tcgcsv:daily:' || s.printing_id || ':' || ${day}
        )
      ORDER BY s.printing_id, s.observed_at DESC`),
  );
  return rows.map((row) => ({
    printingId: row.printing_id,
    game: row.game_key,
    setKey: row.set_key,
    collectorNumber: row.collector_number,
    language: row.language_code,
    variant: row.variant_key,
    productId: Number(row.product_id),
    groupName: row.group_name,
    subType: row.sub_type,
  }));
}

/** tcgcsv's latest build time from last-updated.txt. */
async function readLastUpdated(
  transport: HttpTransport,
): Promise<{ status: "ok"; at: string } | { status: "refused" | "failed"; reason: string }> {
  try {
    const response = await transport.fetch(TCGCSV_LAST_UPDATED_URL, { method: "GET", headers: { "user-agent": TCGCSV_USER_AGENT } });
    if (response.status === 401 || response.status === 403 || response.status === 429) return { status: "refused", reason: `refused_${response.status}` };
    if (response.status < 200 || response.status >= 300) return { status: "failed", reason: `last_updated_http_${response.status}` };
    const text = response.bodyText.trim();
    return Number.isFinite(Date.parse(text)) ? { status: "ok", at: new Date(Date.parse(text)).toISOString() } : { status: "failed", reason: "last_updated_unreadable" };
  } catch {
    return { status: "failed", reason: "last_updated_network" };
  }
}

/** The build time saved with the last completed pull, if any. */
async function lastPulledBuild(db: Database): Promise<string | null> {
  const rows = rowsOf<{ build: string | null }>(
    await db.execute(sql`
      SELECT checkpoint->>'build' AS build FROM provider_sync_run
      WHERE provider_key = 'tcgplayer' AND "trigger" = ${TCGCSV_DAILY_TRIGGER} AND status = 'completed' AND checkpoint->>'build' IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`),
  );
  return rows[0]?.build ?? null;
}

async function saveDay(db: Database, day: string, now: Date, report: TcgcsvDailyReport) {
  const refused = report.reason?.startsWith("refused_") ?? false;
  const checkpoint = { ...report, day, refused };
  const status = report.status === "completed" ? "completed" : "failed";
  await db
    .insert(providerSyncRun)
    .values({
      id: `tcgcsv_daily_${day}`,
      providerKey: "tcgplayer",
      mode: "live",
      trigger: TCGCSV_DAILY_TRIGGER,
      status,
      limitCount: report.targets,
      receivedCount: report.written,
      errorClass: report.status === "completed" ? null : report.reason,
      completedAt: now,
      checkpoint,
    })
    .onConflictDoUpdate({
      target: providerSyncRun.id,
      set: { status, receivedCount: report.written, errorClass: report.status === "completed" ? null : report.reason, startedAt: now, completedAt: now, checkpoint },
    });
}

/**
 * Why the daily step should not run now, or null when it should: off, too
 * early in the UTC day, already done today, or tcgcsv refused within the
 * last TCGCSV_REFUSED_PAUSE_DAYS days.
 */
export async function tcgcsvDailyBlocker(db: Database, env: NodeJS.ProcessEnv, now: Date): Promise<string | null> {
  if (!envFlag(env.TCGCSV_DAILY_ENABLED)) return "disabled";
  if (tcgcsvDailyMaxRequests(env) === 0) return "disabled";
  if (now.getUTCHours() < tcgcsvDailyStartHour(env)) return "before_start_hour";
  const since = new Date(now.getTime() - TCGCSV_REFUSED_PAUSE_DAYS * DAY_MS);
  const rows = rowsOf<{ id: string; status: string; refused: boolean | null }>(
    await db.execute(sql`
      SELECT id, status, (checkpoint->>'refused')::boolean AS refused
      FROM provider_sync_run
      WHERE provider_key = 'tcgplayer' AND "trigger" = ${TCGCSV_DAILY_TRIGGER} AND completed_at >= ${since.toISOString()}`),
  );
  if (rows.some((row) => row.id === `tcgcsv_daily_${utcDay(now)}` && row.status === "completed")) return "done_today";
  if (rows.some((row) => row.refused)) return "refused_recently";
  return null;
}

/**
 * The worker's tcgcsv step: at most one full pass per UTC day, gated by
 * TCGCSV_DAILY_ENABLED and an advisory lock so two replicas never both fetch.
 */
export async function syncTcgcsvDaily(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date; sleep?: (ms: number) => Promise<void>; spacingMs?: number } = {},
): Promise<TcgcsvDailyReport> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const blocker = await withPlatformContext(db, (tx) => tcgcsvDailyBlocker(tx, env, now));
  if (blocker) return { ...emptyTcgcsvReport(), status: "skipped", reason: blocker };
  // Only pull when tcgcsv has published a build newer than the last one pulled.
  const transport = input.transport ?? createFetchTransport({ timeoutMs: 30_000 });
  const build = await readLastUpdated(transport);
  if (build.status !== "ok") {
    const report = { ...emptyTcgcsvReport(), status: build.status === "refused" ? ("stopped" as const) : ("skipped" as const), reason: build.reason, requests: 1 };
    if (build.status === "refused") await withPlatformContext(db, (tx) => saveDay(tx, utcDay(now), now, report));
    return report;
  }
  const lastBuild = await withPlatformContext(db, (tx) => lastPulledBuild(tx));
  if (lastBuild && Date.parse(build.at) <= Date.parse(lastBuild)) {
    return { ...emptyTcgcsvReport(), status: "skipped", reason: "no_new_build", requests: 1 };
  }
  return withPlatformContext(db, async (tx) => {
    const lock = rowsOf<{ locked: boolean }>(
      await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcgcsv.daily.v1')) as locked`),
    );
    if (!lock[0]?.locked) return { ...emptyTcgcsvReport(), status: "skipped" as const, reason: "overlap" };
    const targets = await listTcgcsvTargets(tx, now);
    const { report, records } = await collectTcgcsvDaily({
      targets,
      transport,
      now,
      maxRequests: tcgcsvDailyMaxRequests(env),
      sleep: input.sleep,
      spacingMs: input.spacingMs,
    });
    for (let i = 0; i < records.length; i += 500) {
      const results = await ingestTcgMarketRecordsBatch(tx, records.slice(i, i + 500));
      for (const result of results) if (!(result instanceof Error) && result.status === "processed") report.written += 1;
    }
    report.requests += 1; // last-updated.txt
    report.build = build.at;
    if (report.status !== "skipped") await saveDay(tx, utcDay(now), now, report);
    return report;
  });
}
