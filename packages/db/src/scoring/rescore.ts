import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { scoreAndPersist } from "./persist.js";
import { SCORE_MODEL_REVISION } from "./weights.js";

export const DEFAULT_CARD_RESCORE_BATCH_SIZE = 300;
export const CARD_RESCORE_MAX_BATCH_SIZE = 2_000;
/** A card with a price this recent is worth keeping scored. */
export const CARD_RESCORE_PRICE_DAYS = 30;
/** Scores older than this are refreshed even when no new price arrived (new creator calls, posts). */
export const CARD_RESCORE_MAX_AGE_HOURS = 20;

/** A card someone asked about is rescored when its score is older than this (and older than the request). */
export const CARD_RESCORE_REQUESTED_MIN_AGE_HOURS = 1;
/** Cards asked about in this window count as just requested and go first. */
export const CARD_RESCORE_REQUESTED_HOURS = 24;
/** Share of each batch kept for just-requested cards, so the backlog still moves on busy hours. */
export const CARD_RESCORE_REQUESTED_SHARE = 0.5;

export type CardRescoreReport = {
  status: "completed" | "skipped";
  reason: string | null;
  considered: number;
  /** Of considered, cards picked because tcgcardcentral.com asked about them since their last score. */
  requested: number;
  scored: number;
  failed: number;
};

export function cardRescoreBatchSize(env: NodeJS.ProcessEnv): number {
  const raw = env.CARD_RESCORE_BATCH_SIZE;
  if (raw == null || raw.trim() === "") return DEFAULT_CARD_RESCORE_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CARD_RESCORE_BATCH_SIZE;
  return Math.min(Math.trunc(n), CARD_RESCORE_MAX_BATCH_SIZE);
}

type Row = { printing_id: string; requested: boolean };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

async function hasDemandTable(db: Database): Promise<boolean> {
  const rows = rowsOf<{ present: boolean }>(
    await db.execute(sql`select to_regclass('public.tcg_printing_demand') is not null as present`),
  );
  return rows[0]?.present === true;
}

/**
 * Keeps card scores current. A score is otherwise written only when a new
 * price snapshot is normalized, so a model change (or a creator call, or a
 * price-history backfill) would wait a day or more to show. Each run scores up
 * to batchSize priced printings whose latest score is missing, came from an
 * older model revision, predates the newest price row, is older than
 * CARD_RESCORE_MAX_AGE_HOURS, or predates a request from tcgcardcentral.com
 * (a scan, card page or collection view) by more than an hour.
 *
 * Order: cards asked about in the last day since their last score, up to
 * CARD_RESCORE_REQUESTED_SHARE of the batch, most recent request first; then
 * missing and old-revision scores; then the most requested cards over 30 days;
 * then the oldest score. Before migration 0038 there are no requests, and the
 * order falls back to missing, old revision, oldest.
 */
export async function runCardRescoreBatch(
  db: Database,
  input: { asOf?: Date; batchSize?: number; exclusive?: boolean } = {},
): Promise<CardRescoreReport> {
  const report: CardRescoreReport = { status: "completed", reason: null, considered: 0, requested: 0, scored: 0, failed: 0 };
  const batchSize = Math.max(0, Math.min(input.batchSize ?? DEFAULT_CARD_RESCORE_BATCH_SIZE, CARD_RESCORE_MAX_BATCH_SIZE));
  if (batchSize === 0) return { ...report, status: "skipped", reason: "disabled" };
  if (input.exclusive) {
    const lock = rowsOf<{ locked: boolean }>(
      await db.execute(sql`select pg_try_advisory_xact_lock(hashtext('card.rescore.v1')) as locked`),
    );
    if (!lock[0]?.locked) return { ...report, status: "skipped", reason: "overlap" };
  }
  const asOf = input.asOf ?? new Date();
  const at = asOf.toISOString();
  const priceFrom = new Date(asOf.getTime() - CARD_RESCORE_PRICE_DAYS * 86_400_000);
  const staleBefore = new Date(asOf.getTime() - CARD_RESCORE_MAX_AGE_HOURS * 3_600_000);
  const requestedScoreBefore = new Date(asOf.getTime() - CARD_RESCORE_REQUESTED_MIN_AGE_HOURS * 3_600_000);
  const requestedSince = new Date(asOf.getTime() - CARD_RESCORE_REQUESTED_HOURS * 3_600_000);
  const reserve = Math.max(1, Math.floor(batchSize * CARD_RESCORE_REQUESTED_SHARE));
  const demand = (await hasDemandTable(db))
    ? sql`
        SELECT printing_id, max(last_requested_at) AS last_requested_at, sum(requests) AS requests_30d
        FROM tcg_printing_demand
        WHERE day >= (${priceFrom.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date
          AND last_requested_at <= ${at}::timestamptz
        GROUP BY printing_id`
    : sql`SELECT NULL::text AS printing_id, NULL::timestamptz AS last_requested_at, NULL::bigint AS requests_30d WHERE false`;
  const due = rowsOf<Row>(
    await db.execute(sql`
      WITH candidates AS (
        SELECT p.printing_id,
          s.created_at AS scored_at,
          (s.revision IS DISTINCT FROM ${String(SCORE_MODEL_REVISION)}) AS old_revision,
          COALESCE(d.requests_30d, 0) AS requests_30d,
          d.last_requested_at,
          (d.last_requested_at >= ${requestedSince.toISOString()}::timestamptz
            AND (s.created_at IS NULL OR d.last_requested_at > s.created_at)) AS requested
        FROM (
          SELECT printing_id, max(created_at) AS arrived_at FROM tcg_market_snapshot
          WHERE price_type IN ('reference', 'sold') AND price IS NOT NULL AND outlier_flag = false
            AND grading_company IS NULL
            AND observed_at >= ${priceFrom.toISOString()}::timestamptz
            AND observed_at <= ${at}::timestamptz
          GROUP BY printing_id
        ) p
        LEFT JOIN LATERAL (
          SELECT ss.created_at, (ss.components ->> 'model_revision') AS revision
          FROM tcg_score_snapshot ss
          WHERE ss.printing_id = p.printing_id AND ss.as_of <= ${at}::timestamptz
          ORDER BY ss.as_of DESC, ss.created_at DESC, ss.id DESC
          LIMIT 1
        ) s ON TRUE
        LEFT JOIN (${demand}) d ON d.printing_id = p.printing_id
        WHERE s.created_at IS NULL
          OR s.revision IS DISTINCT FROM ${String(SCORE_MODEL_REVISION)}
          OR s.created_at < p.arrived_at
          OR s.created_at < ${staleBefore.toISOString()}::timestamptz
          OR (d.last_requested_at > s.created_at AND s.created_at < ${requestedScoreBefore.toISOString()}::timestamptz)
      ),
      ranked AS (
        SELECT *, CASE WHEN requested
          THEN row_number() OVER (PARTITION BY requested ORDER BY last_requested_at DESC, printing_id) END AS requested_rank
        FROM candidates
      )
      SELECT printing_id, COALESCE(requested_rank <= ${reserve}, false) AS requested
      FROM ranked
      ORDER BY COALESCE(requested_rank <= ${reserve}, false) DESC,
        requested_rank ASC NULLS LAST,
        scored_at IS NULL DESC,
        old_revision DESC,
        requests_30d DESC,
        scored_at ASC NULLS FIRST,
        printing_id ASC
      LIMIT ${batchSize}
    `),
  );
  report.considered = due.length;
  report.requested = due.filter((row) => row.requested === true).length;
  for (const row of due) {
    try {
      // A savepoint per card, so one failure does not abort the rest of the batch.
      await db.transaction((tx) => scoreAndPersist(tx as unknown as Database, { printingId: row.printing_id, asOf }));
      report.scored += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
