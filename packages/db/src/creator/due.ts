import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { recomputeCreatorAuthority } from "./authority.js";
import { DEFAULT_EVALUATION_DAYS, evaluateCreatorCallOutcome } from "./outcomes.js";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export const DUE_CALL_BATCH = 200;
export const AUTHORITY_RECOMPUTE_BATCH = 25;

export type DueCallScoringReport = {
  considered: number;
  evaluated: number;
  insufficient: number;
  pending: number;
  failed: number;
  creatorsRecomputed: number;
  /** More creators are waiting for an authority refresh than this run handled. */
  moreCreatorsWaiting: boolean;
};

/**
 * Scores creator calls whose horizon has passed, oldest first, then refreshes
 * the authority of every creator whose record changed. Calls with no stated
 * horizon are judged at DEFAULT_EVALUATION_DAYS. Only market data observed
 * inside the call's window is read, so a late run never looks ahead.
 * A call that has been revised is skipped; its revision is scored instead.
 * With `exclusive`, call inside a transaction: it returns null when another
 * run holds the scoring lock.
 */
export async function scoreDueCreatorCalls(
  db: Database,
  input: { asOf?: Date; limit?: number; authorityLimit?: number; exclusive?: boolean } = {},
): Promise<DueCallScoringReport | null> {
  if (input.exclusive) {
    // Transaction-scoped: another replica already scoring returns null here.
    const lock = rowsOf<{ locked: boolean }>(
      await db.execute(sql`select pg_try_advisory_xact_lock(hashtext('creator.call_scoring.v1')) as locked`),
    );
    if (!lock[0]?.locked) return null;
  }
  const asOf = input.asOf ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? DUE_CALL_BATCH, DUE_CALL_BATCH));
  const authorityLimit = Math.max(0, Math.min(input.authorityLimit ?? AUTHORITY_RECOMPUTE_BATCH, AUTHORITY_RECOMPUTE_BATCH));
  const rows = rowsOf<{ call_id: string }>(await db.execute(sql`
    SELECT c.id AS call_id
    FROM creator_call c
    JOIN creator_call_outcome o ON o.call_id = c.id
    WHERE o.evaluation_status = 'pending'
      AND c.status = 'finalized'
      AND NOT EXISTS (SELECT 1 FROM creator_call r WHERE r.revises_call_id = c.id)
      AND c.published_at + make_interval(secs => 86400 * (
        CASE c.horizon_code
          WHEN '7d' THEN 7 WHEN '30d' THEN 30 WHEN '90d' THEN 90
          WHEN '180d' THEN 180 WHEN '365d' THEN 365
          WHEN 'custom' THEN COALESCE(c.horizon_custom_days, 0)
          ELSE ${DEFAULT_EVALUATION_DAYS}
        END)::double precision) <= ${asOf.toISOString()}::timestamptz
    ORDER BY c.published_at ASC, c.id ASC
    LIMIT ${limit}
  `));
  const report: DueCallScoringReport = {
    considered: rows.length,
    evaluated: 0,
    insufficient: 0,
    pending: 0,
    failed: 0,
    creatorsRecomputed: 0,
    moreCreatorsWaiting: false,
  };
  for (const row of rows) {
    try {
      const outcome = await evaluateCreatorCallOutcome(db, row.call_id, asOf);
      if (outcome?.evaluationStatus === "evaluated") {
        report.evaluated += 1;
      } else if (outcome?.evaluationStatus === "insufficient_data") {
        report.insufficient += 1;
      } else {
        report.pending += 1;
      }
    } catch {
      report.failed += 1;
    }
  }
  // Creators whose newest scored call is newer than their newest authority
  // snapshot. Read from the database rather than this run, so a creator
  // deferred by the batch limit is picked up on the next run.
  const stale = rowsOf<{ creator_id: string }>(await db.execute(sql`
    SELECT c.creator_id
    FROM creator_call c
    JOIN creator_call_outcome o ON o.call_id = c.id
    WHERE o.evaluation_status = 'evaluated'
    GROUP BY c.creator_id
    HAVING max(o.evaluated_at) > COALESCE(
      (SELECT max(s.created_at) FROM creator_authority_slice s WHERE s.creator_id = c.creator_id),
      '-infinity'::timestamptz)
    ORDER BY max(o.evaluated_at) ASC, c.creator_id ASC
    LIMIT ${authorityLimit + 1}
  `));
  const creators = stale.map((row) => row.creator_id);
  for (const creatorId of creators.slice(0, authorityLimit)) {
    await recomputeCreatorAuthority(db, creatorId, asOf);
    report.creatorsRecomputed += 1;
  }
  report.moreCreatorsWaiting = creators.length > authorityLimit;
  return report;
}
