/**
 * Daily price history from TCG Card Central for cards named in creator calls
 * that have no price around the call or around its horizon end, so calls
 * collected by the 12-month backfills can be scored.
 *
 * Contract (POST {TCC_API_BASE_URL}/api/public/integrations/social-signal/price-history,
 * Bearer TCC_API_TOKEN): body `{ items: [quote request item], from, to }` with
 * at most 50 items and 400 days; the response is
 * `{ ok: true, from, to, histories: [...] }` in item order, each history
 * `{ status: "ok" | "pending" | "unavailable" | "not_found", reason?, product_id?,
 * group_name?, sub_type?, points: [{ date, market, low, mid, high }] }` with
 * points oldest first, any price possibly null and priceless days omitted.
 * A validation error is 400 `{ ok: false, error }`. The feed allows 30
 * requests a minute per IP, so requests are paced.
 *
 * Writes: one tcg_market_snapshot reference price per printing and day
 * (record id `tcc:history:<printingId>:<date>`), through the synchronous
 * market ingest, so history never enqueues recompute work. Days that already
 * have a daily quote are skipped, and `to` is always yesterday, so today's
 * live quote stays the daily quote job's. Only days inside some call's window
 * are kept. Outcomes those printings left as insufficient_data for missing
 * prices go back to pending so the scorer reads the new prices.
 *
 * State: one provider_sync_run row per printing (provider tcg_card_central,
 * trigger `price_history`, id `pph_…`) whose checkpoint holds the last status,
 * the range already fetched and when to ask again.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isHostedRuntime } from "@isp/shared";
import type { Database } from "../client.js";
import { DEFAULT_EVALUATION_DAYS } from "../creator/outcomes.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { tcgMarketIngest } from "../schema/tcg-market.js";
import { ingestTcgMarketRecord } from "../tcg/market-ingest.js";
import type { TcgMarketRecordInput } from "../tcg/market-identity.js";
import { providerCredentialStatus, resolveProviderMode } from "./catalog.js";
import { ensureProviderRuntimeRows, getProviderRuntime } from "./runtime.js";
import { TCC_QUOTE_BATCH, TCC_QUOTE_GAMES, cardQuoteRecordId, requestItem, type CardTarget } from "./tcc-quotes.js";
import { ProviderHttpError, classifyHttpStatus, createFetchTransport, type HttpTransport } from "./transport.js";

export const TCC_PRICE_HISTORY_PATH = "/api/public/integrations/social-signal/price-history";
export const TCC_PRICE_HISTORY_TRIGGER = "price_history";
export const TCC_PRICE_HISTORY_ID_PREFIX = "pph_";
/** The feed's limits: 50 items and 400 days per request. One day of margin. */
export const TCC_PRICE_HISTORY_MAX_DAYS = 399;
/** Calls made within this many days are considered. */
export const TCC_PRICE_HISTORY_LOOKBACK_DAYS = 400;
export const DEFAULT_TCC_PRICE_HISTORY_ITEMS_PER_RUN = 100;
export const TCC_PRICE_HISTORY_MAX_ITEMS_PER_RUN = 500;
/** 30 requests a minute is the feed's limit; one every 2.5 s stays well under it. */
export const TCC_PRICE_HISTORY_REQUEST_SPACING_MS = 2_500;
/** At most this many daily points are written per run. */
export const TCC_PRICE_HISTORY_MAX_POINTS_PER_RUN = 6_000;
/** The start price may come from a day before or after the call (the scorer accepts up to 2 days after). */
const START_BEFORE_DAYS = 3;
const START_AFTER_DAYS = 2;
/** The scorer needs a close within 7 days before the horizon end. */
const CLOSE_BEFORE_DAYS = 7;

const DAY_MS = 86_400_000;
const RETRY_HOURS = { ok: 24, pending: 6, unavailable: 6, not_found: 24 * 30, failed: 24, invalid: 24 * 7 } as const;

type HistoryPoint = { date: string; market: number | null; low: number | null; mid: number | null; high: number | null };
type History = {
  status: string;
  reason?: string;
  product_id?: number;
  group_name?: string;
  sub_type?: string;
  points?: HistoryPoint[];
};

export type TccPriceHistoryReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  printings: number;
  requests: number;
  ok: number;
  pending: number;
  notFound: number;
  failed: number;
  points: number;
  written: number;
  outcomesReset: number;
};

function emptyReport(): TccPriceHistoryReport {
  return { status: "completed", reason: null, printings: 0, requests: 0, ok: 0, pending: 0, notFound: 0, failed: 0, points: 0, written: 0, outcomesReset: 0 };
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

function dayStart(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}

export function priceHistoryRecordId(printingId: string, date: string) {
  return `tcc:history:${printingId}:${date}`;
}

export function priceHistoryCheckId(printingId: string) {
  return `${TCC_PRICE_HISTORY_ID_PREFIX}${createHash("sha256").update(printingId).digest("hex").slice(0, 32)}`;
}

export function tccPriceHistoryItemsPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TCC_PRICE_HISTORY_ITEMS_PER_RUN;
  if (value == null || value.trim() === "") return DEFAULT_TCC_PRICE_HISTORY_ITEMS_PER_RUN;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > TCC_PRICE_HISTORY_MAX_ITEMS_PER_RUN) {
    throw new Error("Invalid TCC_PRICE_HISTORY_ITEMS_PER_RUN configuration.");
  }
  return parsed;
}

const HORIZON_DAYS_SQL = sql.raw(`(CASE c.horizon_code
  WHEN '7d' THEN 7 WHEN '30d' THEN 30 WHEN '90d' THEN 90
  WHEN '180d' THEN 180 WHEN '365d' THEN 365
  WHEN 'custom' THEN COALESCE(c.horizon_custom_days, 0)
  ELSE ${DEFAULT_EVALUATION_DAYS} END)::double precision`);

/** A day-window of one call: the start price days and, once the horizon has passed, the closing days. */
export type CallWindow = { from: string; to: string };

export type PriceHistoryTarget = CardTarget & {
  windows: CallWindow[];
  needFrom: string;
  needTo: string;
  calls: number;
};

/**
 * Printings named in finalized, resolved card calls of the last 400 days
 * that lack a raw price near the call (when the call stored none) or near a
 * passed horizon end, and are not waiting for their next check. Due-to-score
 * printings first.
 */
export async function listPriceHistoryTargets(db: Database, input: { now: Date; limit: number }): Promise<PriceHistoryTarget[]> {
  if (input.limit < 1) return [];
  const now = input.now;
  const yesterday = utcDay(new Date(now.getTime() - DAY_MS));
  const earliest = utcDay(new Date(dayStart(yesterday).getTime() - TCC_PRICE_HISTORY_MAX_DAYS * DAY_MS));
  const since = new Date(now.getTime() - TCC_PRICE_HISTORY_LOOKBACK_DAYS * DAY_MS);
  const games = sql.join(
    TCC_QUOTE_GAMES.map((game) => sql`${game}`),
    sql`, `,
  );
  const rows = rowsOf<{
    call_id: string;
    printing_id: string;
    published_at: Date | string;
    end_at: Date | string;
    need_start: boolean;
    need_close: boolean;
  }>(
    await db.execute(sql`
      SELECT c.id AS call_id, c.printing_id, c.published_at,
        c.published_at + make_interval(secs => 86400 * ${HORIZON_DAYS_SQL}) AS end_at,
        (c.price_at_call IS NULL AND NOT EXISTS (
          SELECT 1 FROM tcg_market_snapshot s
          WHERE s.printing_id = c.printing_id AND s.price_type IN ('sold', 'reference')
            AND s.grading_company IS NULL AND s.outlier_flag = false
            AND s.observed_at > c.published_at
            AND s.observed_at <= c.published_at + interval '${sql.raw(String(START_AFTER_DAYS))} days')) AS need_start,
        (c.published_at + make_interval(secs => 86400 * ${HORIZON_DAYS_SQL}) <= ${now.toISOString()}::timestamptz
          AND NOT EXISTS (
          SELECT 1 FROM tcg_market_snapshot s
          WHERE s.printing_id = c.printing_id AND s.price_type IN ('sold', 'reference')
            AND s.grading_company IS NULL AND s.outlier_flag = false
            AND s.observed_at <= c.published_at + make_interval(secs => 86400 * ${HORIZON_DAYS_SQL})
            AND s.observed_at >= c.published_at + make_interval(secs => 86400 * ${HORIZON_DAYS_SQL})
              - interval '${sql.raw(String(CLOSE_BEFORE_DAYS))} days')) AS need_close
      FROM creator_call c
      JOIN tcg_printing p ON p.id = c.printing_id
      WHERE c.printing_id IS NOT NULL
        AND c.status = 'finalized'
        AND c.resolution_status IN ('exact', 'high_confidence')
        AND c.published_at >= ${since.toISOString()}::timestamptz
        AND c.published_at < ${now.toISOString()}::timestamptz
        AND p.game_key IN (${games})
        AND ${HORIZON_DAYS_SQL} > 0
        AND NOT EXISTS (SELECT 1 FROM creator_call r WHERE r.revises_call_id = c.id)
      ORDER BY c.published_at ASC, c.id ASC
      LIMIT 5000`),
  );
  type Need = { windows: CallWindow[]; due: boolean; calls: number };
  const byPrinting = new Map<string, Need>();
  for (const row of rows) {
    if (!row.need_start && !row.need_close) continue;
    const published = new Date(row.published_at);
    const endAt = new Date(row.end_at);
    const need = byPrinting.get(row.printing_id) ?? { windows: [], due: false, calls: 0 };
    need.calls += 1;
    if (row.need_start) {
      need.windows.push({
        from: utcDay(new Date(published.getTime() - START_BEFORE_DAYS * DAY_MS)),
        to: utcDay(new Date(published.getTime() + START_AFTER_DAYS * DAY_MS)),
      });
    }
    if (row.need_close) {
      need.due = true;
      need.windows.push({ from: utcDay(new Date(endAt.getTime() - CLOSE_BEFORE_DAYS * DAY_MS)), to: utcDay(endAt) });
    }
    byPrinting.set(row.printing_id, need);
  }
  const clipped = [...byPrinting.entries()]
    .map(([printingId, need]) => {
      const windows = need.windows
        .map((w) => ({ from: w.from < earliest ? earliest : w.from, to: w.to > yesterday ? yesterday : w.to }))
        .filter((w) => w.from <= w.to);
      return { printingId, need: { ...need, windows } };
    })
    .filter((entry) => entry.need.windows.length > 0);
  if (clipped.length === 0) return [];

  const ids = clipped.map((entry) => entry.printingId);
  const checks = new Map(
    rowsOf<{ id: string; checkpoint: unknown }>(
      await db.execute(sql`
        SELECT id, checkpoint FROM provider_sync_run
        WHERE provider_key = 'tcg_card_central' AND "trigger" = ${TCC_PRICE_HISTORY_TRIGGER}
          AND id IN (${sql.join(ids.map((id) => sql`${priceHistoryCheckId(id)}`), sql`, `)})`),
    ).map((row) => [row.id, (typeof row.checkpoint === "string" ? JSON.parse(row.checkpoint) : row.checkpoint) as Record<string, unknown> | null]),
  );
  const eligible = clipped.filter(({ printingId, need }) => {
    const check = checks.get(priceHistoryCheckId(printingId));
    if (!check) return true;
    const next = typeof check.next_attempt_at === "string" ? Date.parse(check.next_attempt_at) : NaN;
    if (Number.isFinite(next) && next > now.getTime()) return false;
    // A range fetched successfully has nothing new until a window outside it appears.
    const from = typeof check.covered_from === "string" ? check.covered_from : null;
    const to = typeof check.covered_to === "string" ? check.covered_to : null;
    if (check.status === "ok" && from && to) return need.windows.some((w) => w.from < from || w.to > to);
    return true;
  });
  eligible.sort((a, b) => Number(b.need.due) - Number(a.need.due) || b.need.calls - a.need.calls || a.printingId.localeCompare(b.printingId));
  const picked = eligible.slice(0, input.limit);
  if (picked.length === 0) return [];

  const details = rowsOf<{
    printing_id: string;
    game: string;
    set_key: string;
    set_name: string;
    collector_number: string;
    card_name: string;
    language: string;
    variant: string;
  }>(
    await db.execute(sql`
      SELECT p.id AS printing_id, p.game_key AS game, s.canonical_set_key AS set_key, s.name AS set_name,
        p.collector_number, cc.canonical_name AS card_name, p.language_code AS language, p.variant_key AS variant
      FROM tcg_printing p
      JOIN tcg_set s ON s.id = p.set_id
      JOIN tcg_card_concept cc ON cc.id = p.card_id
      WHERE p.id IN (${sql.join(picked.map((entry) => sql`${entry.printingId}`), sql`, `)})`),
  );
  const detailById = new Map(details.map((row) => [row.printing_id, row]));
  const targets: PriceHistoryTarget[] = [];
  for (const { printingId, need } of picked) {
    const d = detailById.get(printingId);
    if (!d) continue;
    targets.push({
      kind: "card",
      printingId,
      game: d.game,
      setKey: d.set_key,
      setName: d.set_name,
      collectorNumber: d.collector_number,
      cardName: d.card_name,
      language: d.language,
      variant: d.variant,
      windows: need.windows,
      needFrom: need.windows.reduce((min, w) => (w.from < min ? w.from : min), need.windows[0]!.from),
      needTo: need.windows.reduce((max, w) => (w.to > max ? w.to : max), need.windows[0]!.to),
      calls: need.calls,
    });
  }
  return targets;
}

/**
 * Groups targets into requests of at most 50 items whose combined range stays
 * within the feed's 400 days. Targets are sorted by range start so nearby
 * calls share a request.
 */
export function planPriceHistoryRequests(targets: PriceHistoryTarget[]) {
  const sorted = [...targets].sort((a, b) => a.needFrom.localeCompare(b.needFrom) || a.printingId.localeCompare(b.printingId));
  const batches: Array<{ from: string; to: string; targets: PriceHistoryTarget[] }> = [];
  for (const target of sorted) {
    const last = batches.at(-1);
    if (last && last.targets.length < TCC_QUOTE_BATCH) {
      const from = target.needFrom < last.from ? target.needFrom : last.from;
      const to = target.needTo > last.to ? target.needTo : last.to;
      if ((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS <= TCC_PRICE_HISTORY_MAX_DAYS) {
        last.from = from;
        last.to = to;
        last.targets.push(target);
        continue;
      }
    }
    batches.push({ from: target.needFrom, to: target.needTo, targets: [target] });
  }
  return batches;
}

function finitePrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Points of a history inside the target's windows, with a positive market price, by day. */
export function usableHistoryPoints(target: Pick<PriceHistoryTarget, "windows">, history: History) {
  const out = new Map<string, { market: number; low: number | null; mid: number | null; high: number | null }>();
  for (const point of Array.isArray(history.points) ? history.points : []) {
    if (!point || typeof point.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const market = finitePrice(point.market);
    if (market == null) continue;
    if (!target.windows.some((w) => point.date >= w.from && point.date <= w.to)) continue;
    out.set(point.date, { market, low: finitePrice(point.low), mid: finitePrice(point.mid), high: finitePrice(point.high) });
  }
  return out;
}

function historyRecord(
  target: CardTarget,
  history: History,
  date: string,
  point: { market: number; low: number | null; mid: number | null; high: number | null },
): TcgMarketRecordInput {
  return {
    provider: "tcg_card_central",
    provider_record_id: priceHistoryRecordId(target.printingId, date),
    event_type: "tcg.market.reference_price",
    market_type: "market_price",
    price_type: "reference",
    // The day's market price, stamped at the end of that day: a call made that
    // day may start from it, and no price is dated before the day it describes.
    observed_at: `${date}T23:59:59.000Z`,
    // The feed prices TCGplayer listings, which are USD.
    currency: "USD",
    condition: "unknown",
    raw_condition: "product_level",
    price: point.market,
    low_price: point.low,
    high_price: point.high,
    median_price: point.mid,
    source_reference: history.product_id ? `tcgplayer:${history.product_id}` : null,
    printing: {
      game: target.game,
      set: target.setKey,
      collector_number: target.collectorNumber,
      language: target.language,
      variant: target.variant,
    },
    attributes: {
      tcgplayer_product_id: history.product_id ?? null,
      tcgplayer_group_name: history.group_name ?? null,
      tcgplayer_sub_type: history.sub_type ?? null,
      price_source: "tcgplayer_market_history_via_tcg_card_central",
    },
  };
}

async function saveCheck(
  db: Database,
  input: { printingId: string; status: string; reason: string | null; from: string; to: string; written: number; now: Date; previous?: Record<string, unknown> | null },
) {
  const hours = RETRY_HOURS[input.status as keyof typeof RETRY_HOURS] ?? RETRY_HOURS.failed;
  // A pending or unavailable answer is retried sooner the first few times.
  const jitter = input.status === "pending" || input.status === "unavailable" ? Math.floor(Math.random() * 6) : 0;
  const prevFrom = typeof input.previous?.covered_from === "string" ? input.previous.covered_from : null;
  const prevTo = typeof input.previous?.covered_to === "string" ? input.previous.covered_to : null;
  const ok = input.status === "ok";
  const checkpoint = {
    printing_id: input.printingId,
    status: input.status,
    reason: input.reason,
    requested_from: input.from,
    requested_to: input.to,
    covered_from: ok ? (prevFrom && prevFrom < input.from && prevTo && prevTo >= input.from ? prevFrom : input.from) : prevFrom,
    covered_to: ok ? (prevTo && prevTo > input.to && prevFrom && prevFrom <= input.to ? prevTo : input.to) : prevTo,
    points_written: input.written,
    next_attempt_at: new Date(input.now.getTime() + (hours + jitter) * 3_600_000).toISOString(),
  };
  const id = priceHistoryCheckId(input.printingId);
  const status = ok || input.status === "not_found" ? "completed" : input.status === "failed" || input.status === "invalid" ? "failed" : "skipped";
  await db
    .insert(providerSyncRun)
    .values({
      id,
      providerKey: "tcg_card_central",
      mode: "live",
      trigger: TCC_PRICE_HISTORY_TRIGGER,
      status,
      limitCount: 1,
      receivedCount: input.written,
      errorClass: ok ? null : input.status,
      completedAt: input.now,
      checkpoint,
    })
    .onConflictDoUpdate({
      target: providerSyncRun.id,
      set: { status, receivedCount: input.written, errorClass: ok ? null : input.status, startedAt: input.now, completedAt: input.now, checkpoint },
    });
}

/**
 * Outcomes of these printings' calls that were left insufficient for want of
 * a price go back to pending, so the next scoring run reads the new history.
 */
async function resetStarvedOutcomes(db: Database, printingIds: string[]) {
  if (printingIds.length === 0) return 0;
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE creator_call_outcome o
      SET evaluation_status = 'pending', data_quality = 'awaiting_rescore_price_history', evaluated_at = NULL
      FROM creator_call c
      WHERE o.call_id = c.id
        AND o.evaluation_status = 'insufficient_data'
        AND o.data_quality IN ('missing_market_data', 'missing_identity_price_or_horizon')
        AND c.printing_id IN (${sql.join(printingIds.map((id) => sql`${id}`), sql`, `)})
        AND c.resolution_status IN ('exact', 'high_confidence')
        AND c.status = 'finalized'
        AND ${HORIZON_DAYS_SQL} > 0
      RETURNING o.id`),
  );
  return rows.length;
}

function parseBody(bodyText: string): { histories: History[] } | null {
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { ok?: unknown; histories?: unknown };
  if (body.ok === false || !Array.isArray(body.histories)) return null;
  return { histories: body.histories as History[] };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches and stores price history for up to `items` printings, in requests of
 * at most 50, spaced TCC_PRICE_HISTORY_REQUEST_SPACING_MS apart. A 429 or a
 * transport failure stops the run (what was written stays); a 400 marks that
 * request's printings `invalid` for a week. Call inside withPlatformContext.
 */
export async function collectTccPriceHistory(
  db: Database,
  input: {
    baseUrl: string;
    token: string;
    items: number;
    transport?: HttpTransport;
    now?: Date;
    sleep?: (ms: number) => Promise<void>;
    spacingMs?: number;
    maxPoints?: number;
  },
): Promise<TccPriceHistoryReport> {
  const report = emptyReport();
  const now = input.now ?? new Date();
  const items = Math.max(0, Math.min(input.items, TCC_PRICE_HISTORY_MAX_ITEMS_PER_RUN));
  const targets = await listPriceHistoryTargets(db, { now, limit: items });
  report.printings = targets.length;
  if (targets.length === 0) return { ...report, status: "skipped", reason: "nothing_to_fetch" };
  // A year of daily points for 50 cards is a larger answer than a quote; allow it longer.
  const transport = input.transport ?? createFetchTransport({ timeoutMs: 30_000 });
  const sleep = input.sleep ?? defaultSleep;
  const spacing = input.spacingMs ?? TCC_PRICE_HISTORY_REQUEST_SPACING_MS;
  const maxPoints = input.maxPoints ?? TCC_PRICE_HISTORY_MAX_POINTS_PER_RUN;
  const url = `${input.baseUrl.replace(/\/$/, "")}${TCC_PRICE_HISTORY_PATH}`;
  const touched = new Set<string>();
  const previous = new Map(
    rowsOf<{ id: string; checkpoint: unknown }>(
      await db.execute(sql`
        SELECT id, checkpoint FROM provider_sync_run
        WHERE id IN (${sql.join(targets.map((t) => sql`${priceHistoryCheckId(t.printingId)}`), sql`, `)})`),
    ).map((row) => [row.id, (typeof row.checkpoint === "string" ? JSON.parse(row.checkpoint) : row.checkpoint) as Record<string, unknown> | null]),
  );

  for (const [index, batch] of planPriceHistoryRequests(targets).entries()) {
    if (report.written >= maxPoints) {
      report.status = "stopped";
      report.reason = "points_cap";
      break;
    }
    if (index > 0 && spacing > 0) await sleep(spacing);
    report.requests += 1;
    let response;
    try {
      response = await transport.fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${input.token}` },
        body: JSON.stringify({ items: batch.targets.map(requestItem), from: batch.from, to: batch.to }),
      });
    } catch (error) {
      report.status = "stopped";
      report.reason = error instanceof ProviderHttpError ? error.errorClass : "network";
      break;
    }
    if (response.status === 400) {
      // The request itself was refused; the items are not asked again for a week.
      for (const target of batch.targets) {
        await saveCheck(db, { printingId: target.printingId, status: "invalid", reason: "validation_error", from: batch.from, to: batch.to, written: 0, now, previous: previous.get(priceHistoryCheckId(target.printingId)) });
      }
      report.failed += batch.targets.length;
      continue;
    }
    const errorClass = classifyHttpStatus(response.status);
    if (errorClass !== "ok") {
      report.status = "stopped";
      report.reason = errorClass;
      break;
    }
    const body = parseBody(response.bodyText);
    if (!body) {
      for (const target of batch.targets) {
        await saveCheck(db, { printingId: target.printingId, status: "failed", reason: "invalid_payload", from: batch.from, to: batch.to, written: 0, now, previous: previous.get(priceHistoryCheckId(target.printingId)) });
      }
      report.failed += batch.targets.length;
      continue;
    }
    for (const [position, target] of batch.targets.entries()) {
      const history = body.histories[position];
      const prev = previous.get(priceHistoryCheckId(target.printingId));
      const status = history && typeof history.status === "string" ? history.status : "failed";
      if (status !== "ok" || !history) {
        const known = status === "pending" || status === "unavailable" || status === "not_found" ? status : "failed";
        if (known === "not_found") report.notFound += 1;
        else if (known === "failed") report.failed += 1;
        else report.pending += 1;
        await saveCheck(db, { printingId: target.printingId, status: known, reason: typeof history?.reason === "string" ? history.reason.slice(0, 80) : null, from: batch.from, to: batch.to, written: 0, now, previous: prev });
        continue;
      }
      report.ok += 1;
      const points = usableHistoryPoints(target, history);
      report.points += points.size;
      const dates = [...points.keys()];
      const taken = new Set(
        dates.length
          ? (
              await db
                .select({ id: tcgMarketIngest.sourceRecordId })
                .from(tcgMarketIngest)
                .where(
                  and(
                    eq(tcgMarketIngest.sourceKey, "tcg_card_central"),
                    inArray(tcgMarketIngest.sourceRecordId, [
                      ...dates.map((date) => cardQuoteRecordId(target.printingId, date)),
                      ...dates.map((date) => priceHistoryRecordId(target.printingId, date)),
                    ]),
                  ),
                )
            ).map((row) => row.id)
          : [],
      );
      let written = 0;
      for (const [date, point] of points) {
        if (report.written >= maxPoints) break;
        if (taken.has(cardQuoteRecordId(target.printingId, date)) || taken.has(priceHistoryRecordId(target.printingId, date))) continue;
        try {
          const result = await ingestTcgMarketRecord(db, historyRecord(target, history, date, point));
          if (result.status === "processed") {
            written += 1;
            report.written += 1;
          }
        } catch {
          // A record the market ingest refuses (identity, revision) is skipped; the rest still land.
        }
      }
      if (written > 0) touched.add(target.printingId);
      await saveCheck(db, { printingId: target.printingId, status: "ok", reason: null, from: batch.from, to: batch.to, written, now, previous: prev });
    }
  }
  report.outcomesReset = await resetStarvedOutcomes(db, [...touched]);
  return report;
}

/**
 * The worker's price history step: runs only when TCG Card Central is live
 * with its base URL and token (the daily quote job's gating), honoring the
 * provider's pause, hosted enable control and retry-after. Bounded by
 * TCC_PRICE_HISTORY_ITEMS_PER_RUN printings (0 turns it off).
 */
export async function syncTccPriceHistory(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TccPriceHistoryReport> {
  const env = input.env ?? process.env;
  const items = tccPriceHistoryItemsPerRun(env);
  if (items === 0) return { ...emptyReport(), status: "skipped", reason: "disabled" };
  if (resolveProviderMode("tcg_card_central", env) !== "live") return { ...emptyReport(), status: "skipped", reason: "tcc_not_live" };
  const baseUrl = env.TCC_API_BASE_URL?.trim() ?? "";
  const token = env.TCC_API_TOKEN?.trim() ?? "";
  if (!baseUrl || !token || !providerCredentialStatus("tcg_card_central", env).present) {
    return { ...emptyReport(), status: "skipped", reason: "disabled_pending_credentials" };
  }
  const runtime = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    return getProviderRuntime(tx, "tcg_card_central");
  });
  if (runtime?.paused || (isHostedRuntime(env) && !runtime?.enabled)) return { ...emptyReport(), status: "skipped", reason: "paused_or_disabled" };
  if (runtime?.retryAfterAt && runtime.retryAfterAt.getTime() > Date.now()) return { ...emptyReport(), status: "skipped", reason: "throttled" };
  // Advisory lock so two replicas never fetch the same printings.
  return withPlatformContext(db, async (tx) => {
    const lock = rowsOf<{ locked: boolean }>(
      await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcc.price_history.v1')) as locked`),
    );
    if (!lock[0]?.locked) return { ...emptyReport(), status: "skipped" as const, reason: "overlap" };
    return collectTccPriceHistory(tx, { baseUrl, token, items, transport: input.transport, now: input.now, sleep: input.sleep });
  });
}
