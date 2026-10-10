/**
 * Creator leaderboard: how often each creator's calls of the last twelve
 * months came true. A call counts as evaluated when its outcome is scored and
 * directional (correct or incorrect); accuracy is correct / evaluated. Ranking
 * is by the lower bound of the 95% Wilson interval, so five calls out of five
 * do not outrank forty out of fifty. Creators with fewer than `minEvaluated`
 * evaluated calls are listed separately as not having enough calls yet.
 *
 * The authority weight shown is the one card sentiment and scoring already
 * apply (the creator's newest overall authority slice, all-time); the
 * leaderboard reads it and changes nothing.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { wilsonInterval } from "./stats.js";

export const LEADERBOARD_WINDOW_DAYS = 365;
export const LEADERBOARD_MIN_EVALUATED = 5;
export const LEADERBOARD_MAX_ROWS = 500;

export type CreatorLeaderboardRow = {
  rank: number | null;
  creatorId: string;
  name: string | null;
  platforms: string[];
  callsMade: number;
  callsEvaluated: number;
  cameTrue: number;
  accuracy: number | null;
  wilsonLow: number | null;
  authorityWeight: number | null;
  trustState: string | null;
  lastCallAt: string | null;
};

export type CreatorLeaderboard = {
  game: string | null;
  windowDays: number;
  minEvaluated: number;
  from: string;
  to: string;
  ranked: CreatorLeaderboardRow[];
  notEnoughCalls: CreatorLeaderboardRow[];
};

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/** Pure ranking: Wilson low, then accuracy, then evaluated count, then name. */
export function rankLeaderboard(rows: Omit<CreatorLeaderboardRow, "rank" | "accuracy" | "wilsonLow">[], minEvaluated: number) {
  const scored = rows.map((row) => {
    const wilson = row.callsEvaluated > 0 ? wilsonInterval(row.cameTrue, row.callsEvaluated) : null;
    return {
      ...row,
      rank: null as number | null,
      accuracy: wilson ? Number(wilson.raw.toFixed(4)) : null,
      wilsonLow: wilson ? Number(wilson.low.toFixed(4)) : null,
    };
  });
  const ranked = scored
    .filter((row) => row.callsEvaluated >= minEvaluated)
    .sort(
      (a, b) =>
        (b.wilsonLow ?? 0) - (a.wilsonLow ?? 0) ||
        (b.accuracy ?? 0) - (a.accuracy ?? 0) ||
        b.callsEvaluated - a.callsEvaluated ||
        (a.name ?? a.creatorId).localeCompare(b.name ?? b.creatorId),
    );
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  const notEnoughCalls = scored
    .filter((row) => row.callsEvaluated < minEvaluated)
    .sort((a, b) => b.callsEvaluated - a.callsEvaluated || b.callsMade - a.callsMade || (a.name ?? a.creatorId).localeCompare(b.name ?? b.creatorId));
  return { ranked, notEnoughCalls };
}

/**
 * The leaderboard for one game (card calls by printing game, sealed/asset
 * calls by the asset's game), over finalized, unrevised calls published in
 * the last LEADERBOARD_WINDOW_DAYS days. Creators an operator excluded and
 * those in `hiddenCreatorIds` (the workspace's own exclusions) are left out.
 */
export async function getCreatorLeaderboard(
  db: Database,
  input: { game?: string | null; now?: Date; minEvaluated?: number; hiddenCreatorIds?: string[]; limit?: number } = {},
): Promise<CreatorLeaderboard> {
  const now = input.now ?? new Date();
  const from = new Date(now.getTime() - LEADERBOARD_WINDOW_DAYS * 86_400_000);
  const minEvaluated = Math.max(1, input.minEvaluated ?? LEADERBOARD_MIN_EVALUATED);
  const limit = Math.max(1, Math.min(input.limit ?? LEADERBOARD_MAX_ROWS, LEADERBOARD_MAX_ROWS));
  const game = input.game?.trim() || null;
  const hidden = input.hiddenCreatorIds ?? [];
  const rows = rowsOf<{
    creator_id: string;
    name: string | null;
    calls_made: number | string;
    calls_evaluated: number | string;
    came_true: number | string;
    last_call_at: Date | string | null;
    platforms: string[] | string | null;
    authority_weight: string | null;
    trust_state: string | null;
  }>(
    await db.execute(sql`
      WITH calls AS (
        SELECT c.creator_id, c.published_at, o.evaluation_status, o.directional_correct
        FROM creator_call c
        LEFT JOIN creator_call_outcome o ON o.call_id = c.id
        LEFT JOIN tcg_printing p ON p.id = c.printing_id
        LEFT JOIN market_asset a ON a.id = c.asset_id
        WHERE c.status = 'finalized'
          AND NOT EXISTS (SELECT 1 FROM creator_call r WHERE r.revises_call_id = c.id)
          AND c.published_at > ${from.toISOString()}::timestamptz
          AND c.published_at <= ${now.toISOString()}::timestamptz
          ${game ? sql`AND COALESCE(p.game_key, a.game_key) = ${game}` : sql``}
          ${hidden.length ? sql`AND c.creator_id NOT IN (${sql.join(hidden.map((id) => sql`${id}`), sql`, `)})` : sql``}
      ),
      per_creator AS (
        SELECT creator_id,
          count(*) AS calls_made,
          count(*) FILTER (WHERE evaluation_status = 'evaluated' AND directional_correct IN ('correct', 'incorrect')) AS calls_evaluated,
          count(*) FILTER (WHERE evaluation_status = 'evaluated' AND directional_correct = 'correct') AS came_true,
          max(published_at) AS last_call_at
        FROM calls GROUP BY creator_id
      )
      SELECT pc.creator_id, cr.display_name AS name, pc.calls_made, pc.calls_evaluated, pc.came_true, pc.last_call_at,
        (SELECT array_agg(DISTINCT sa.source_type ORDER BY sa.source_type)
         FROM creator_source_account csa JOIN source_account sa ON sa.id = csa.source_account_id
         WHERE csa.creator_id = pc.creator_id) AS platforms,
        slice.authority_weight, slice.trust_state
      FROM per_creator pc
      JOIN creator cr ON cr.id = pc.creator_id
      LEFT JOIN LATERAL (
        SELECT s.authority_weight, s.trust_state FROM creator_authority_slice s
        WHERE s.creator_id = pc.creator_id
          AND s.game_key IS NULL AND s.language_code IS NULL AND s.price_tier = 'all' AND s.horizon_code IS NULL
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1
      ) slice ON TRUE
      WHERE COALESCE((
        SELECT te.trust_state FROM creator_trust_event te
        WHERE te.creator_id = pc.creator_id
        ORDER BY te.created_at DESC LIMIT 1), '') <> 'excluded'
      ORDER BY pc.calls_evaluated DESC, pc.calls_made DESC, pc.creator_id
      LIMIT ${limit}`),
  );
  const parsed = rows.map((row) => ({
    creatorId: row.creator_id,
    name: row.name,
    platforms: Array.isArray(row.platforms)
      ? row.platforms
      : typeof row.platforms === "string"
        ? row.platforms.replace(/^\{|\}$/g, "").split(",").filter(Boolean)
        : [],
    callsMade: Number(row.calls_made),
    callsEvaluated: Number(row.calls_evaluated),
    cameTrue: Number(row.came_true),
    lastCallAt: row.last_call_at == null ? null : new Date(row.last_call_at).toISOString(),
    authorityWeight: row.authority_weight == null ? null : Number(row.authority_weight),
    trustState: row.trust_state,
  }));
  const { ranked, notEnoughCalls } = rankLeaderboard(parsed, minEvaluated);
  return {
    game,
    windowDays: LEADERBOARD_WINDOW_DAYS,
    minEvaluated,
    from: from.toISOString(),
    to: now.toISOString(),
    ranked,
    notEnoughCalls,
  };
}
