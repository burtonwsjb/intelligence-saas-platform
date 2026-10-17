/**
 * Reads asset calls (sets, sealed products) out of posts stored before those
 * assets existed, once each per ASSET_CALL_RESCAN_KEY. Posts are walked
 * oldest first behind a cursor kept in a provider_sync_run checkpoint
 * (provider `web_feed`, trigger `asset_call_rescan`), at most `limit` per run.
 * Extraction is idempotent, so a post whose calls already exist is unchanged.
 * Database only.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { extractAssetCallsFromContent, listActiveAssets } from "./assets.js";

/** Bumped when new kinds of assets can be named in old posts; restarts the walk. */
export const ASSET_CALL_RESCAN_KEY = "set_assets.v1";
export const ASSET_CALL_RESCAN_TRIGGER = "asset_call_rescan";
export const ASSET_CALL_RESCAN_DEFAULT_LIMIT = 500;

export type AssetCallRescanReport = { scanned: number; callsCreated: number; failed: number };

type Cursor = { publishedAt: string; id: string };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

async function readCursor(db: Database): Promise<Cursor | null> {
  const [row] = await db
    .select({ checkpoint: providerSyncRun.checkpoint })
    .from(providerSyncRun)
    .where(and(eq(providerSyncRun.providerKey, "web_feed"), eq(providerSyncRun.trigger, ASSET_CALL_RESCAN_TRIGGER)))
    .orderBy(desc(providerSyncRun.startedAt), desc(providerSyncRun.id))
    .limit(1);
  const checkpoint = row?.checkpoint ?? {};
  if (checkpoint.key !== ASSET_CALL_RESCAN_KEY) return null;
  const publishedAt = typeof checkpoint.published_at === "string" ? checkpoint.published_at : null;
  const id = typeof checkpoint.content_id === "string" ? checkpoint.content_id : null;
  return publishedAt && id ? { publishedAt, id } : null;
}

export async function rescanAssetCalls(
  db: Database,
  options: { limit?: number; now?: Date } = {},
): Promise<AssetCallRescanReport> {
  const limit = Math.max(1, Math.min(options.limit ?? ASSET_CALL_RESCAN_DEFAULT_LIMIT, 2_000));
  const startedAt = options.now ?? new Date();
  const report: AssetCallRescanReport = { scanned: 0, callsCreated: 0, failed: 0 };
  const cursor = await withPlatformContext(db, (tx) => readCursor(tx));
  const rows = await withPlatformContext(db, async (tx) =>
    rowsOf<{ id: string; published_at: string | Date }>(
      await tx.execute(sql`
        SELECT sc.id, sc.published_at
        FROM source_content sc
        WHERE sc.created_at < ${startedAt.toISOString()}::timestamptz
          ${cursor ? sql`AND (sc.published_at, sc.id) > (${cursor.publishedAt}::timestamptz, ${cursor.id})` : sql``}
        ORDER BY sc.published_at, sc.id
        LIMIT ${limit}
      `),
    ),
  );
  if (rows.length === 0) return report;
  const assets = await withPlatformContext(db, (tx) => listActiveAssets(tx));
  if (assets.length === 0) return report;

  for (const row of rows) {
    report.scanned += 1;
    // One transaction per post, so one failure never undoes the others.
    const results = await withPlatformContext(db, (tx) => extractAssetCallsFromContent(tx, row.id, undefined, assets)).catch(
      () => null,
    );
    if (results == null) report.failed += 1;
    else report.callsCreated += results.filter((result) => result.status === "processed").length;
  }

  const last = rows.at(-1)!;
  const lastPublishedAt =
    last.published_at instanceof Date ? last.published_at.toISOString() : new Date(last.published_at).toISOString();
  await withPlatformContext(db, (tx) =>
    tx.insert(providerSyncRun).values({
      id: `pac_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      providerKey: "web_feed",
      mode: "live",
      trigger: ASSET_CALL_RESCAN_TRIGGER,
      status: "completed",
      limitCount: limit,
      receivedCount: report.callsCreated,
      startedAt,
      completedAt: new Date(),
      checkpoint: {
        key: ASSET_CALL_RESCAN_KEY,
        published_at: lastPublishedAt,
        content_id: last.id,
        scanned: report.scanned,
        calls_created: report.callsCreated,
        failed: report.failed,
      },
    }),
  );
  return report;
}
