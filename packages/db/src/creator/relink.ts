/**
 * Gives creator calls that could not be graded another chance, a bounded
 * batch per run. Database only: nothing here fetches from any outside site.
 *
 * 1. Relink: a card call whose mention the resolver left unbound under an
 *    older RESOLVER_VERSION is resolved again. When it now binds a printing,
 *    or at least names one card, a revision of the call is written (calls are
 *    immutable) and call scoring grades the revision.
 *    A call whose "mention" is the whole post title and still names no card
 *    is general market talk; its outcome says so instead of "missing data".
 * 2. Recheck: a call marked insufficient for missing prices is looked at
 *    again once a week while price history backfills, for up to a year.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { resolveSourceMention } from "../resolution/resolve.js";
import { RESOLVER_VERSION } from "../resolution/identity.js";
import { withPlatformContext } from "../rls.js";
import { mayBindCallPrinting } from "./identity.js";
import { relinkCreatorCall } from "./ingest.js";
import { OUTCOME_VERSION } from "./outcomes.js";

export const CALL_RELINK_DEFAULT_LIMIT = 300;
export const CALL_RECHECK_DEFAULT_LIMIT = 300;
export const GENERAL_MARKET_TALK = "general_market_talk";
const RECHECK_AFTER_DAYS = 7;
const RECHECK_MAX_AGE_DAYS = 400;

export type CallRelinkReport = {
  considered: number;
  bound: number;
  cardOnly: number;
  generalTalk: number;
  stillUnbound: number;
  superseded: number;
  failed: number;
  rechecked: number;
};

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

type UnboundCall = {
  id: string;
  creator_id: string;
  content_id: string;
  mention_id: string;
  direction: string;
  title_mention: boolean;
};

export async function relinkUnboundCalls(
  db: Database,
  options: { limit?: number; recheckLimit?: number; now?: Date } = {},
): Promise<CallRelinkReport> {
  const limit = Math.max(0, Math.min(options.limit ?? CALL_RELINK_DEFAULT_LIMIT, 2_000));
  const recheckLimit = Math.max(0, Math.min(options.recheckLimit ?? CALL_RECHECK_DEFAULT_LIMIT, 2_000));
  const now = options.now ?? new Date();
  const report: CallRelinkReport = {
    considered: 0,
    bound: 0,
    cardOnly: 0,
    generalTalk: 0,
    stillUnbound: 0,
    superseded: 0,
    failed: 0,
    rechecked: 0,
  };

  const rows = await withPlatformContext(db, async (tx) =>
    rowsOf<UnboundCall>(
      await tx.execute(sql`
        SELECT c.id, c.creator_id, c.content_id, c.mention_id, c.direction,
               (m.raw_entity_text = sc.title) AS title_mention
        FROM creator_call c
        JOIN source_mention m ON m.id = c.mention_id
        JOIN source_content sc ON sc.id = c.content_id
        JOIN creator_call_outcome o ON o.call_id = c.id
        LEFT JOIN LATERAL (
          SELECT a.resolver_version FROM entity_resolution_attempt a
          WHERE a.mention_id = c.mention_id
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE c.status = 'finalized'
          AND c.asset_id IS NULL
          AND c.printing_id IS NULL
          AND c.resolution_status IN ('unresolved', 'ambiguous', 'probable')
          AND o.evaluation_status <> 'evaluated'
          AND NOT EXISTS (SELECT 1 FROM creator_call r WHERE r.revises_call_id = c.id)
          AND COALESCE(latest.resolver_version, '') <> ${RESOLVER_VERSION}
        ORDER BY c.published_at DESC, c.id
        LIMIT ${limit}
      `),
    ),
  );

  for (const row of rows) {
    report.considered += 1;
    // One transaction per call, so one failure never undoes the others.
    const outcome = await withPlatformContext(db, (tx) => relinkOne(tx, row)).catch(() => "failed" as const);
    if (outcome === "failed") report.failed += 1;
    else if (outcome === "bound") report.bound += 1;
    else if (outcome === "card_only") report.cardOnly += 1;
    else if (outcome === "general_talk") report.generalTalk += 1;
    else if (outcome === "superseded") report.superseded += 1;
    else report.stillUnbound += 1;
  }

  if (recheckLimit > 0) {
    const rechecked = await withPlatformContext(db, async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE creator_call_outcome o
          SET evaluation_status = 'pending', data_quality = 'recheck_market_data', evaluated_at = NULL
          WHERE o.id IN (
            SELECT o2.id
            FROM creator_call_outcome o2
            JOIN creator_call c ON c.id = o2.call_id
            WHERE o2.evaluation_status = 'insufficient_data'
              AND c.status = 'finalized'
              AND (c.printing_id IS NOT NULL OR c.asset_id IS NOT NULL OR c.concept_id IS NOT NULL)
              AND COALESCE(o2.data_quality, '') <> ${GENERAL_MARKET_TALK}
              AND c.published_at > ${now.toISOString()}::timestamptz - make_interval(days => ${RECHECK_MAX_AGE_DAYS})
              AND (COALESCE(o2.method_version, '') <> ${OUTCOME_VERSION}
                   OR o2.evaluated_at IS NULL
                   OR o2.evaluated_at < ${now.toISOString()}::timestamptz - make_interval(days => ${RECHECK_AFTER_DAYS}))
            ORDER BY o2.evaluated_at ASC NULLS FIRST, o2.id
            LIMIT ${recheckLimit}
          )
          RETURNING o.id
        `),
      ),
    );
    report.rechecked = rechecked.length;
  }
  return report;
}

async function relinkOne(
  tx: Database,
  row: UnboundCall,
): Promise<"bound" | "card_only" | "general_talk" | "superseded" | "unbound"> {
  const resolution = await resolveSourceMention(tx, row.mention_id);
  const attempt = resolution.attempt;
  const boundPrinting = mayBindCallPrinting(attempt.status) ? attempt.chosenPrintingId : null;
  let conceptId = attempt.chosenConceptId ?? null;
  if (boundPrinting && !conceptId) {
    const [printing] = rowsOf<{ card_id: string }>(
      await tx.execute(sql`SELECT card_id FROM tcg_printing WHERE id = ${boundPrinting}`),
    );
    conceptId = printing?.card_id ?? null;
  }

  if (boundPrinting || conceptId) {
    if (boundPrinting) {
      // The same post may already carry a call on this printing (from a later
      // re-read); that one is graded, so no revision is written.
      const [twin] = rowsOf<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM creator_call
          WHERE status = 'finalized' AND id <> ${row.id}
            AND creator_id = ${row.creator_id} AND content_id = ${row.content_id}
            AND printing_id = ${boundPrinting} AND direction = ${row.direction}
          LIMIT 1
        `),
      );
      if (twin) return "superseded";
    }
    const result = await relinkCreatorCall(tx, {
      callId: row.id,
      printingId: boundPrinting,
      conceptId,
      resolutionAttemptId: attempt.id,
      resolutionStatus: attempt.status,
      resolutionConfidence: attempt.confidence ?? null,
    });
    if (result.status !== "processed") return "superseded";
    // The original stays as the record of what was first read; it is no longer graded.
    await tx.execute(sql`
      UPDATE creator_call_outcome SET data_quality = 'relinked', method_version = ${OUTCOME_VERSION}, evaluated_at = now()
      WHERE call_id = ${row.id} AND evaluation_status <> 'evaluated'
    `);
    return boundPrinting ? "bound" : "card_only";
  }
  if (row.title_mention) {
    await tx.execute(sql`
      UPDATE creator_call_outcome SET evaluation_status = 'insufficient_data', data_quality = ${GENERAL_MARKET_TALK},
        method_version = ${OUTCOME_VERSION}, evaluated_at = now()
      WHERE call_id = ${row.id} AND evaluation_status <> 'evaluated'
    `);
    return "general_talk";
  }
  return "unbound";
}
