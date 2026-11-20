/**
 * Shared pieces of the tcgcsv.com steps (daily prices, card-list matching,
 * price archive). tcgcsv's usage guidelines (tcgcsv.com/docs), followed by
 * every step:
 * - A custom User-Agent naming the app ("TCGSentiment/1.0 (+site)").
 * - A pause between requests (250 ms here; tcgcsv asks for at least 100 ms).
 * - Check last-updated.txt and sync only when it shows a newer build; never
 *   re-request the same data within a day.
 * - Under 10,000 requests a day (each step has a per-run cap; together they
 *   stay far below it). Empty categories [9, 10, 12, 14, 21, 55, 69, 70] are
 *   never read.
 * - The price archive is only for past days, each downloaded once.
 * A 401/403/429 from tcgcsv pauses every step for TCGCSV_REFUSED_PAUSE_DAYS.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import type { HttpTransport } from "./transport.js";

export const TCGCSV_BASE = "https://tcgcsv.com/tcgplayer";
export const TCGCSV_LAST_UPDATED_URL = "https://tcgcsv.com/last-updated.txt";
export const TCGCSV_USER_AGENT = "TCGSentiment/1.0 (+https://tcgsentiment.com)";
export const TCGCSV_REQUEST_SPACING_MS = 250;
export const TCGCSV_REFUSED_PAUSE_DAYS = 7;
/** Categories tcgcsv asks every client to skip (empty or retired). */
export const TCGCSV_SKIPPED_CATEGORIES = new Set([9, 10, 12, 14, 21, 55, 69, 70]);
/** provider_sync_run triggers of the tcgcsv steps (provider tcgplayer). */
export const TCGCSV_TRIGGERS = ["tcgcsv_daily", "tcgcsv_match", "tcgcsv_archive"] as const;

/**
 * Games in the owner's order (2026-11-20): Pokemon, One Piece, Yu-Gi-Oh,
 * Magic, Marvel, Lorcana, Dragon Ball, Gundam, Union Arena, My Little Pony,
 * then the rest. Games Sentiment's catalog has no printings for are skipped
 * by the steps (they have nothing to link).
 */
export const TCGCSV_GAME_ORDER = [
  "pokemon",
  "one_piece",
  "yugioh",
  "magic",
  "marvel",
  "lorcana",
  "dragon_ball",
  "gundam",
  "union_arena",
  "my_little_pony",
  "digimon",
  "flesh_and_blood",
  "star_wars_unlimited",
] as const;

const DAY_MS = 86_400_000;

export function normName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** The Sentiment game a tcgcsv category belongs to, or null (Japanese and other-language categories are never used). */
export function gameForCategory(category: { categoryId?: unknown; name?: unknown; displayName?: unknown }): string | null {
  const id = Number(category.categoryId);
  if (TCGCSV_SKIPPED_CATEGORIES.has(id)) return null;
  const n = normName(String(category.name ?? category.displayName ?? ""));
  if (!n || /japan|japanese|chinese|korean/.test(n)) return null;
  if (n === "pokemon") return "pokemon";
  if (n === "onepiececardgame") return "one_piece";
  if (n === "yugioh") return "yugioh";
  if (n === "magic") return "magic";
  if (n.includes("lorcana")) return "lorcana";
  if (n.startsWith("dragonball")) return "dragon_ball";
  if (n.includes("gundam")) return "gundam";
  if (n.includes("unionarena")) return "union_arena";
  if (n === "mylittleponyccg") return "my_little_pony";
  if (n.startsWith("digimon")) return "digimon";
  if (n.startsWith("fleshblood")) return "flesh_and_blood";
  if (n.includes("starwarsunlimited")) return "star_wars_unlimited";
  if (n.includes("marvel")) return "marvel";
  return null;
}

export function gameRank(game: string): number {
  const i = (TCGCSV_GAME_ORDER as readonly string[]).indexOf(game);
  return i === -1 ? TCGCSV_GAME_ORDER.length : i;
}

export class TcgcsvRefused extends Error {
  constructor(readonly status: number) {
    super(`refused_${status}`);
  }
}

export class TcgcsvCapReached extends Error {
  constructor() {
    super("request_cap");
  }
}

/** A paced, counted, capped GET client for tcgcsv's JSON and text files. */
export function tcgcsvClient(input: {
  transport: HttpTransport;
  maxRequests: number;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}) {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spacing = Math.max(input.spacingMs ?? TCGCSV_REQUEST_SPACING_MS, 0);
  const state = { requests: 0 };
  async function getText(url: string): Promise<string> {
    if (state.requests >= input.maxRequests) throw new TcgcsvCapReached();
    if (state.requests > 0 && spacing > 0) await sleep(spacing);
    state.requests += 1;
    const response = await input.transport.fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/plain", "user-agent": TCGCSV_USER_AGENT },
    });
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new TcgcsvRefused(response.status);
    if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
    return response.bodyText;
  }
  async function getList<T>(path: string): Promise<T[]> {
    const body = JSON.parse(await getText(`${TCGCSV_BASE}/${path}`)) as { results?: unknown };
    if (!body || !Array.isArray(body.results)) throw new Error("invalid_payload");
    return body.results as T[];
  }
  /** tcgcsv's latest build time (ISO), from last-updated.txt. */
  async function lastUpdated(): Promise<string> {
    const text = (await getText(TCGCSV_LAST_UPDATED_URL)).trim();
    const at = Date.parse(text);
    if (!Number.isFinite(at)) throw new Error("last_updated_unreadable");
    return new Date(at).toISOString();
  }
  return { state, getText, getList, lastUpdated };
}

export function errorReason(error: unknown): string {
  if (error instanceof TcgcsvRefused || error instanceof TcgcsvCapReached) return error.message;
  return error instanceof Error ? error.message.slice(0, 80) : "failed";
}

export function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

export function utcDay(at: Date | string) {
  return (typeof at === "string" ? new Date(at) : at).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number) {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

/** The time every slim price of `day` carries: 20:00 UTC, about when tcgcsv publishes. */
export function priceTimeForDay(day: string): Date {
  return new Date(`${day}T20:00:00.000Z`);
}

export function envFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function envInt(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  const v = value?.trim() && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(v, max));
}

/** True when any tcgcsv step was refused within the pause window. */
export async function tcgcsvRefusedRecently(db: Database, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - TCGCSV_REFUSED_PAUSE_DAYS * DAY_MS).toISOString();
  const rows = rowsOf<{ n: number | string }>(
    await db.execute(sql`
      SELECT count(*) AS n FROM provider_sync_run
      WHERE provider_key = 'tcgplayer' AND "trigger" IN ('tcgcsv_daily', 'tcgcsv_match', 'tcgcsv_archive')
        AND completed_at >= ${since}::timestamptz
        AND coalesce((checkpoint->>'refused')::boolean, false)`),
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Saves (or updates) one tcgcsv step's state row. */
export async function saveTcgcsvRun(
  db: Database,
  input: { id: string; trigger: (typeof TCGCSV_TRIGGERS)[number]; status: "completed" | "failed" | "skipped"; now: Date; received: number; errorClass: string | null; checkpoint: Record<string, unknown> },
) {
  const checkpoint = JSON.stringify(input.checkpoint);
  await db.execute(sql`
    INSERT INTO provider_sync_run (id, provider_key, mode, "trigger", status, limit_count, received_count, error_class, started_at, completed_at, checkpoint)
    VALUES (${input.id}, 'tcgplayer', 'live', ${input.trigger}, ${input.status}, NULL, ${input.received}, ${input.errorClass},
      ${input.now.toISOString()}::timestamptz, ${input.now.toISOString()}::timestamptz, ${checkpoint}::jsonb)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, received_count = EXCLUDED.received_count,
      error_class = EXCLUDED.error_class, started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at,
      checkpoint = EXCLUDED.checkpoint`);
}

/** Inserts slim daily prices; an existing (printing, day) row is kept. Returns rows written. */
export async function insertDailyPrices(
  db: Database,
  rows: Array<{ printingId: string; observedAt: Date; market: number; low: number | null; mid: number | null; high: number | null; source: "daily" | "archive" }>,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 1_000) {
    const chunk = rows.slice(i, i + 1_000);
    const result = rowsOf<{ printing_id: string }>(
      await db.execute(sql`
        INSERT INTO tcg_daily_price (printing_id, observed_at, market, low, mid, high, source)
        VALUES ${sql.join(
          chunk.map(
            (r) =>
              sql`(${r.printingId}, ${r.observedAt.toISOString()}::timestamptz, ${r.market}, ${r.low}, ${r.mid}, ${r.high}, ${r.source})`,
          ),
          sql`, `,
        )}
        ON CONFLICT (printing_id, observed_at) DO NOTHING
        RETURNING printing_id`),
    );
    written += result.length;
  }
  return written;
}

export type TcgcsvPriceRow = {
  productId?: unknown;
  subTypeName?: unknown;
  marketPrice?: unknown;
  lowPrice?: unknown;
  midPrice?: unknown;
  highPrice?: unknown;
};

function price(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** The price row for the product and sub-type, with a market price; null otherwise. */
export function pickTcgcsvRow(rows: TcgcsvPriceRow[], target: { productId: number; subType: string }) {
  const want = normName(target.subType);
  const row = rows.find(
    (r) => Number(r.productId) === target.productId && typeof r.subTypeName === "string" && normName(r.subTypeName) === want,
  );
  const market = row ? price(row.marketPrice) : null;
  if (!row || market == null) return null;
  return { market, low: price(row.lowPrice), mid: price(row.midPrice), high: price(row.highPrice) };
}
