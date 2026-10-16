/**
 * Re-resolves card mentions found in posts and transcripts that an earlier
 * resolver left unbound (ambiguous, probable or unresolved), once each per
 * MENTION_RETRY_KEY. Mentions are walked oldest first behind a cursor kept in
 * a provider_sync_run checkpoint (provider `web_feed`, trigger
 * `mention_retry`), at most `limit` per run, and posts with a newly bound
 * mention get their creator calls extracted again. Database only.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { extractCreatorCallsFromContent } from "../creator/ingest.js";
import { resolveSourceMention } from "../resolution/resolve.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";

/** Bumped when the resolver learns something that can bind mentions it left unbound; restarts the walk. */
export const MENTION_RETRY_KEY = "short_set_keys.v1";
export const MENTION_RETRY_TRIGGER = "mention_retry";
export const MENTION_RETRY_DEFAULT_LIMIT = 5_000;

export type MentionRetryReport = { scanned: number; retried: number; bound: number; callsCreated: number };

type Cursor = { createdAt: string; id: string };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

async function readCursor(db: Database): Promise<Cursor | null> {
  const [row] = await db
    .select({ checkpoint: providerSyncRun.checkpoint })
    .from(providerSyncRun)
    .where(and(eq(providerSyncRun.providerKey, "web_feed"), eq(providerSyncRun.trigger, MENTION_RETRY_TRIGGER)))
    .orderBy(desc(providerSyncRun.startedAt), desc(providerSyncRun.id))
    .limit(1);
  const checkpoint = row?.checkpoint ?? {};
  if (checkpoint.key !== MENTION_RETRY_KEY) return null;
  const createdAt = typeof checkpoint.created_at === "string" ? checkpoint.created_at : null;
  const id = typeof checkpoint.mention_id === "string" ? checkpoint.mention_id : null;
  return createdAt && id ? { createdAt, id } : null;
}

export async function retryUnboundDetectedMentions(
  db: Database,
  options: { limit?: number; now?: Date } = {},
): Promise<MentionRetryReport> {
  const limit = Math.max(1, Math.min(options.limit ?? MENTION_RETRY_DEFAULT_LIMIT, 5_000));
  const startedAt = options.now ?? new Date();
  const report: MentionRetryReport = { scanned: 0, retried: 0, bound: 0, callsCreated: 0 };
  const cursor = await withPlatformContext(db, (tx) => readCursor(tx));
  const rows = await withPlatformContext(db, async (tx) =>
    rowsOf<{ id: string; content_id: string; created_at: string | Date; status: string | null }>(
      await tx.execute(sql`
        SELECT sm.id, sm.content_id, sm.created_at, latest.status
        FROM source_mention sm
        LEFT JOIN LATERAL (
          SELECT a.status FROM entity_resolution_attempt a
          WHERE a.mention_id = sm.id
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE (sm.metadata ? 'card_detect' OR sm.metadata ? 'transcript')
          AND sm.created_at < ${startedAt.toISOString()}::timestamptz
          ${cursor ? sql`AND (sm.created_at, sm.id) > (${cursor.createdAt}::timestamptz, ${cursor.id})` : sql``}
        ORDER BY sm.created_at, sm.id
        LIMIT ${limit}
      `),
    ),
  );
  if (rows.length === 0) return report;

  const contents = new Set<string>();
  for (const row of rows) {
    report.scanned += 1;
    if (row.status === "exact" || row.status === "high_confidence") continue;
    report.retried += 1;
    // One transaction per mention, so one failure never undoes the others.
    const status = await withPlatformContext(db, async (tx) => (await resolveSourceMention(tx, row.id)).attempt.status).catch(
      () => null,
    );
    if (status === "exact" || status === "high_confidence") {
      report.bound += 1;
      contents.add(row.content_id);
    }
  }
  for (const contentId of contents) {
    const calls = await withPlatformContext(db, (tx) => extractCreatorCallsFromContent(tx, contentId)).catch(() => []);
    report.callsCreated += calls.filter((call) => call.status === "processed").length;
  }

  const last = rows.at(-1)!;
  const lastCreatedAt = last.created_at instanceof Date ? last.created_at.toISOString() : new Date(last.created_at).toISOString();
  await withPlatformContext(db, (tx) =>
    tx.insert(providerSyncRun).values({
      id: `pmr_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      providerKey: "web_feed",
      mode: "live",
      trigger: MENTION_RETRY_TRIGGER,
      status: "completed",
      limitCount: null,
      receivedCount: report.bound,
      startedAt,
      completedAt: new Date(),
      checkpoint: {
        key: MENTION_RETRY_KEY,
        created_at: lastCreatedAt,
        mention_id: last.id,
        scanned: report.scanned,
        retried: report.retried,
        bound: report.bound,
        calls_created: report.callsCreated,
      },
    }),
  );
  return report;
}
