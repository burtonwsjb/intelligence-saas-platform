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

export type CardRescoreReport = {
  status: "completed" | "skipped";
  reason: string | null;
  considered: number;
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

type Row = { printing_id: string };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * Keeps card scores current. A score is otherwise written only when a new
 * price snapshot is normalized, so a model change (or a creator call, or a
 * price-history backfill) would wait a day or more to show. Each run scores up
 * to batchSize priced printings whose latest score is missing, came from an
 * older model revision, predates the newest price row, or is older than
 * CARD_RESCORE_MAX_AGE_HOURS. Missing and old-revision scores go first.
 */
export async function runCardRescoreBatch(
  db: Database,
  input: { asOf?: Date; batchSize?: number; exclusive?: boolean } = {},
): Promise<CardRescoreReport> {
  const report: CardRescoreReport = { status: "completed", reason: null, considered: 0, scored: 0, failed: 0 };
  const batchSize = Math.max(0, Math.min(input.batchSize ?? DEFAULT_CARD_RESCORE_BATCH_SIZE, CARD_RESCORE_MAX_BATCH_SIZE));
  if (batchSize === 0) return { ...report, status: "skipped", reason: "disabled" };
  if (input.exclusive) {
    const lock = rowsOf<{ locked: boolean }>(
      await db.execute(sql`select pg_try_advisory_xact_lock(hashtext('card.rescore.v1')) as locked`),
    );
    if (!lock[0]?.locked) return { ...report, status: "skipped", reason: "overlap" };
  }
  const asOf = input.asOf ?? new Date();
  const priceFrom = new Date(asOf.getTime() - CARD_RESCORE_PRICE_DAYS * 86_400_000);
  const staleBefore = new Date(asOf.getTime() - CARD_RESCORE_MAX_AGE_HOURS * 3_600_000);
  const due = rowsOf<Row>(
    await db.execute(sql`
      SELECT p.printing_id
      FROM (
        SELECT printing_id, max(created_at) AS arrived_at FROM tcg_market_snapshot
        WHERE price_type IN ('reference', 'sold') AND price IS NOT NULL AND outlier_flag = false
          AND grading_company IS NULL
          AND observed_at >= ${priceFrom.toISOString()}::timestamptz
          AND observed_at <= ${asOf.toISOString()}::timestamptz
        GROUP BY printing_id
      ) p
      LEFT JOIN LATERAL (
        SELECT ss.created_at, (ss.components ->> 'model_revision') AS revision
        FROM tcg_score_snapshot ss
        WHERE ss.printing_id = p.printing_id AND ss.as_of <= ${asOf.toISOString()}::timestamptz
        ORDER BY ss.as_of DESC, ss.created_at DESC, ss.id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE s.created_at IS NULL
        OR s.revision IS DISTINCT FROM ${String(SCORE_MODEL_REVISION)}
        OR s.created_at < p.arrived_at
        OR s.created_at < ${staleBefore.toISOString()}::timestamptz
      ORDER BY s.created_at IS NULL DESC,
        (s.revision IS DISTINCT FROM ${String(SCORE_MODEL_REVISION)}) DESC,
        s.created_at ASC NULLS FIRST, p.printing_id ASC
      LIMIT ${batchSize}
    `),
  );
  report.considered = due.length;
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
