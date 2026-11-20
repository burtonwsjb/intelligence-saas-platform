/**
 * Past TCGplayer market prices from tcgcsv.com's price archive, for every
 * printing linked to a TCGplayer product (tcg_tcgplayer_link), written to the
 * slim tcg_daily_price table (source `archive`). OFF unless
 * TCGCSV_HISTORY_ENABLED=1.
 *
 * Each archive (https://tcgcsv.com/archive/tcgplayer/prices-<date>.ppmd.7z,
 * 2-4 MB, from 2024-02-08) holds every set's prices for that date. tcgcsv's
 * rules for the archive, followed here:
 * - Archives never change: each day is downloaded ONCE, ever. A day whose
 *   download answered 200 is never downloaded again, even if extracting it
 *   failed. (State: one provider_sync_run row per day, provider tcgplayer,
 *   trigger `tcgcsv_archive`, id `tcgcsv_archive_<date>`.)
 * - Downloading the whole archive once is fine; downloading archives day
 *   after day instead of the daily price files is not. So this step only
 *   walks backwards from yesterday to TCGCSV_HISTORY_FROM (default
 *   2025-11-09, a year) and then stops for good; days the daily step fully
 *   pulled are skipped. Today's prices always come from the daily step.
 * - Clear User-Agent; TCGCSV_HISTORY_DAYS_PER_RUN (default 2, at most 6)
 *   archives per hourly run, 10 s apart. A 401/403/429 stops every tcgcsv
 *   step for 7 days.
 *
 * Newest days first, so the gap since 2026-11-09 (when TCG Card Central's
 * feed stopped) fills in the first hours. A printing-day that already has a
 * reference price from any source (e.g. TCC history) is skipped, so nothing
 * doubles up. Needs the `7z` program (7-Zip) on the server.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import {
  TCGCSV_SKIPPED_CATEGORIES,
  TCGCSV_USER_AGENT,
  addDays,
  envFlag,
  envInt,
  insertDailyPrices,
  pickTcgcsvRow,
  priceTimeForDay,
  rowsOf,
  saveTcgcsvRun,
  tcgcsvRefusedRecently,
  utcDay,
  type TcgcsvPriceRow,
} from "./tcgcsv-common.js";

export const TCGCSV_ARCHIVE_BASE = "https://tcgcsv.com/archive/tcgplayer";
export const TCGCSV_ARCHIVE_TRIGGER = "tcgcsv_archive";
export const TCGCSV_FIRST_ARCHIVE_DAY = "2024-02-08";
export const DEFAULT_TCGCSV_HISTORY_FROM = "2025-11-09";
export const DEFAULT_TCGCSV_HISTORY_DAYS_PER_RUN = 2;
export const TCGCSV_MAX_HISTORY_DAYS_PER_RUN = 6;
export const TCGCSV_ARCHIVE_SPACING_MS = 10_000;
/**
 * TCGplayer category ids for links whose set is not yet tied to a tcgcsv
 * group (the daily step's catalog pass fills category ids in).
 */
export const TCGCSV_KNOWN_CATEGORIES: Record<string, number> = { magic: 1, yugioh: 2, pokemon: 3, one_piece: 68 };

type PriceRow = TcgcsvPriceRow;

/** One archive day: price rows by product id, or why there are none. `downloaded` = the file was received (never ask again). */
export type TcgcsvArchive =
  | { status: "ok"; byProduct: Map<number, PriceRow[]> }
  | { status: "missing" | "refused" | "failed"; reason: string; downloaded: boolean };

export type TcgcsvArchiveReader = (day: string, categories: number[]) => Promise<TcgcsvArchive>;

export type TcgcsvHistoryDay = { day: string; status: string; reason: string | null; priced: number; missing: number; skipped: number; written: number };

export type TcgcsvHistoryReport = {
  status: "completed" | "stopped" | "skipped";
  reason: string | null;
  targets: number;
  downloads: number;
  days: TcgcsvHistoryDay[];
  written: number;
};

function emptyReport(): TcgcsvHistoryReport {
  return { status: "completed", reason: null, targets: 0, downloads: 0, days: [], written: 0 };
}

export function tcgcsvHistorySettings(env: NodeJS.ProcessEnv) {
  const raw = env.TCGCSV_HISTORY_FROM?.trim() ?? "";
  const from = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : DEFAULT_TCGCSV_HISTORY_FROM;
  return {
    enabled: envFlag(env.TCGCSV_HISTORY_ENABLED),
    from: from < TCGCSV_FIRST_ARCHIVE_DAY ? TCGCSV_FIRST_ARCHIVE_DAY : from,
    daysPerRun: envInt(env.TCGCSV_HISTORY_DAYS_PER_RUN, DEFAULT_TCGCSV_HISTORY_DAYS_PER_RUN, 0, TCGCSV_MAX_HISTORY_DAYS_PER_RUN),
  };
}

/** Newest-first days before today, back to `from`, that are not done. */
export function plannedArchiveDays(input: { now: Date; from: string; done: Set<string>; limit: number }): string[] {
  const days: string[] = [];
  for (let day = addDays(utcDay(input.now), -1); day >= input.from && days.length < input.limit; day = addDays(day, -1)) {
    if (!input.done.has(day)) days.push(day);
  }
  return days;
}

/** Builds a product id → price rows index from extracted `<day>/<category>/<group>/prices` files. */
export async function indexArchiveDir(root: string, day: string, categories: number[]): Promise<Map<number, PriceRow[]>> {
  const byProduct = new Map<number, PriceRow[]>();
  for (const category of categories) {
    if (TCGCSV_SKIPPED_CATEGORIES.has(category)) continue;
    const dir = join(root, day, String(category));
    let groups: string[];
    try {
      groups = await readdir(dir);
    } catch {
      continue;
    }
    for (const group of groups) {
      let body: { results?: unknown };
      try {
        body = JSON.parse(await readFile(join(dir, group, "prices"), "utf8")) as { results?: unknown };
      } catch {
        continue;
      }
      for (const row of Array.isArray(body.results) ? (body.results as PriceRow[]) : []) {
        const id = Number(row.productId);
        if (!Number.isInteger(id)) continue;
        byProduct.set(id, [...(byProduct.get(id) ?? []), row]);
      }
    }
  }
  return byProduct;
}

const run = promisify(execFile);

/** Downloads one archive day and indexes the listed categories. Needs `7z` on PATH. */
export const downloadTcgcsvArchive: TcgcsvArchiveReader = async (day, categories) => {
  let response: Response;
  try {
    response = await fetch(`${TCGCSV_ARCHIVE_BASE}/prices-${day}.ppmd.7z`, {
      headers: { "user-agent": TCGCSV_USER_AGENT },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message.slice(0, 80) : "network", downloaded: false };
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    return { status: "refused", reason: `refused_${response.status}`, downloaded: false };
  }
  if (response.status === 404) return { status: "missing", reason: "no_archive", downloaded: false };
  if (!response.ok) return { status: "failed", reason: `http_${response.status}`, downloaded: false };
  const dir = await mkdtemp(join(tmpdir(), "tcgcsv-"));
  try {
    const file = join(dir, "prices.7z");
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const wanted = categories.filter((c) => !TCGCSV_SKIPPED_CATEGORIES.has(c)).map((c) => `${day}/${c}/*`);
    await run("7z", ["x", "-y", `-o${dir}`, file, ...wanted, "-r"], { maxBuffer: 16 * 1024 * 1024 });
    return { status: "ok", byProduct: await indexArchiveDir(dir, day, categories) };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? `extract: ${error.message.slice(0, 70)}` : "extract", downloaded: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Printings among `ids` that already have a reference price on `day` (any source). */
async function pricedOn(db: Database, day: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 5_000) {
    const chunk = ids.slice(i, i + 5_000);
    const rows = rowsOf<{ printing_id: string }>(
      await db.execute(sql`
        SELECT DISTINCT printing_id FROM tcg_market_price_all
        WHERE price_type = 'reference'
          AND observed_at >= ${`${day}T00:00:00.000Z`} AND observed_at < ${`${addDays(day, 1)}T00:00:00.000Z`}
          AND printing_id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`),
    );
    for (const row of rows) out.add(row.printing_id);
  }
  return out;
}

async function saveDay(db: Database, now: Date, day: TcgcsvHistoryDay, done: boolean) {
  await saveTcgcsvRun(db, {
    id: `tcgcsv_archive_${day.day}`,
    trigger: "tcgcsv_archive",
    status: done ? "completed" : "failed",
    now,
    received: day.written,
    errorClass: day.status === "ok" ? null : day.reason,
    checkpoint: { ...day, refused: day.status === "refused", downloaded: done },
  });
}

type LinkTarget = { printingId: string; game: string; categoryId: number | null; productId: number; subType: string };

async function listLinkTargets(db: Database): Promise<LinkTarget[]> {
  const rows = rowsOf<{ printing_id: string; game_key: string; category_id: number | null; product_id: number; sub_type: string }>(
    await db.execute(sql`
      SELECT l.printing_id, p.game_key, l.category_id, l.product_id, l.sub_type
      FROM tcg_tcgplayer_link l JOIN tcg_printing p ON p.id = l.printing_id`),
  );
  return rows.map((r) => ({
    printingId: r.printing_id,
    game: r.game_key,
    categoryId: r.category_id == null ? null : Number(r.category_id),
    productId: Number(r.product_id),
    subType: r.sub_type,
  }));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The worker's archive step: up to TCGCSV_HISTORY_DAYS_PER_RUN archive days
 * per run, newest first, each downloaded at most once ever.
 */
export async function syncTcgcsvHistory(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; now?: Date; readArchive?: TcgcsvArchiveReader; sleep?: (ms: number) => Promise<void>; spacingMs?: number } = {},
): Promise<TcgcsvHistoryReport> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const settings = tcgcsvHistorySettings(env);
  if (!settings.enabled || settings.daysPerRun === 0) return { ...emptyReport(), status: "skipped", reason: "disabled" };
  const readArchive = input.readArchive ?? downloadTcgcsvArchive;
  const sleep = input.sleep ?? defaultSleep;
  const spacing = Math.max(input.spacingMs ?? TCGCSV_ARCHIVE_SPACING_MS, 0);
  return withPlatformContext(db, async (tx) => {
    const lock = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext('tcgcsv.archive.v1')) as locked`));
    if (!lock[0]?.locked) return { ...emptyReport(), status: "skipped" as const, reason: "overlap" };
    if (await tcgcsvRefusedRecently(tx, now)) return { ...emptyReport(), status: "skipped" as const, reason: "refused_recently" };
    // Done: archive days downloaded once, and days the daily step fully pulled.
    const state = rowsOf<{ id: string }>(
      await tx.execute(sql`
        SELECT id FROM provider_sync_run
        WHERE provider_key = 'tcgplayer' AND "trigger" IN ('tcgcsv_archive', 'tcgcsv_daily') AND status = 'completed'`),
    );
    const done = new Set(state.map((row) => row.id.replace(/^tcgcsv_(archive|daily)_/, "")));
    const days = plannedArchiveDays({ now, from: settings.from, done, limit: settings.daysPerRun });
    if (days.length === 0) return { ...emptyReport(), status: "skipped" as const, reason: "nothing_due" };
    const report = emptyReport();
    const targets = await listLinkTargets(tx);
    report.targets = targets.length;
    if (targets.length === 0) return { ...report, status: "skipped" as const, reason: "nothing_linked" };
    const categories = [
      ...new Set(targets.map((t) => t.categoryId ?? TCGCSV_KNOWN_CATEGORIES[t.game]).filter((c): c is number => c != null)),
    ].sort((a, b) => a - b);

    for (const [index, day] of days.entries()) {
      if (index > 0 && spacing > 0) await sleep(spacing);
      report.downloads += 1;
      const archive = await readArchive(day, categories);
      const dayReport: TcgcsvHistoryDay = { day, status: archive.status, reason: archive.status === "ok" ? null : archive.reason, priced: 0, missing: 0, skipped: 0, written: 0 };
      report.days.push(dayReport);
      if (archive.status !== "ok") {
        // A received file is never asked for again; a 404 day has no archive and is not asked again either.
        await saveDay(tx, now, dayReport, archive.downloaded || archive.status === "missing");
        if (archive.status === "refused") {
          report.status = "stopped";
          report.reason = archive.reason;
          break;
        }
        continue;
      }
      const taken = await pricedOn(tx, day, targets.map((t) => t.printingId));
      const observedAt = priceTimeForDay(day);
      const prices = [];
      for (const target of targets) {
        if (taken.has(target.printingId)) {
          dayReport.skipped += 1;
          continue;
        }
        const point = pickTcgcsvRow(archive.byProduct.get(target.productId) ?? [], target);
        if (!point) {
          dayReport.missing += 1;
          continue;
        }
        dayReport.priced += 1;
        prices.push({ printingId: target.printingId, observedAt, ...point, source: "archive" as const });
      }
      dayReport.written = await insertDailyPrices(tx, prices);
      report.written += dayReport.written;
      await saveDay(tx, now, dayReport, true);
    }
    return report;
  });
}
