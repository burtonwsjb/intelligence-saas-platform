import { sql } from "drizzle-orm";
import type { Database } from "../client.js";

/** Most printings one request can count; TCC's batch route sends up to 100. */
const DEMAND_MAX_PRINTINGS = 100;

/**
 * Counts one request from tcgcardcentral.com (a scan, a card page or a
 * collection view) for each printing, in that UTC day's row. The hourly card
 * rescore reads it to refresh what people just asked about first, then the
 * most requested cards. Runs in a savepoint and never throws: a database where
 * migration 0038 has not run yet, or any write failure, leaves the API answer
 * untouched.
 */
export async function recordPrintingDemand(db: Database, printingIds: string[], at: Date = new Date()): Promise<void> {
  const ids = [...new Set(printingIds)].slice(0, DEMAND_MAX_PRINTINGS);
  if (ids.length === 0) return;
  const values = sql.join(
    ids.map((id) => sql`(${id})`),
    sql`, `,
  );
  try {
    await db.transaction((tx) =>
      tx.execute(sql`
        INSERT INTO tcg_printing_demand (printing_id, day, requests, last_requested_at)
        SELECT v.printing_id, (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date, 1, ${at.toISOString()}::timestamptz
        FROM (VALUES ${values}) AS v(printing_id)
        ORDER BY v.printing_id
        ON CONFLICT (printing_id, day) DO UPDATE
          SET requests = tcg_printing_demand.requests + 1,
              last_requested_at = GREATEST(tcg_printing_demand.last_requested_at, EXCLUDED.last_requested_at)
      `),
    );
  } catch {
    // Demand only orders the rescore; losing a count is harmless.
  }
}
