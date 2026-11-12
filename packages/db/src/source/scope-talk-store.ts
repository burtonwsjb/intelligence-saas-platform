/**
 * Stores scoped market talk (source/scope-talk.ts) for a post: its title,
 * summary and excerpt, its stored segments, and (from the transcript
 * backfill) every transcript window, including windows that name no card.
 * Rows for a post are replaced as a whole, so re-reading a post never
 * double counts. Older posts are read by a bounded rescan behind a cursor.
 * Everything here is a no-op until migration 0042 creates the table.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { marketScopeTalk } from "../schema/scope-talk.js";
import { sourceContent, sourceContentSegment } from "../schema/source.js";
import { tcgSet } from "../schema/tcg.js";
import { loadCardNameIndex, type CardNameIndex } from "./card-detect.js";
import { stableSourceId } from "./identity.js";
import {
  SCOPE_TALK_VERSION,
  buildScopeSetIndex,
  extractScopeTalk,
  type ScopeSetIndex,
  type ScopeTalkStatement,
} from "./scope-talk.js";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

let tableSeen = false;
let tableCheckedAt = 0;

/** True once migration 0042 is applied. A missing table is checked again every 10 minutes. */
export async function scopeTalkReady(db: Database): Promise<boolean> {
  if (tableSeen) return true;
  if (Date.now() - tableCheckedAt < 600_000 && tableCheckedAt > 0) return false;
  const [row] = rowsOf<{ name: string | null }>(await db.execute(sql`SELECT to_regclass('market_scope_talk')::text AS name`));
  tableCheckedAt = Date.now();
  tableSeen = row?.name != null;
  return tableSeen;
}

export async function loadScopeSetIndex(db: Database): Promise<ScopeSetIndex> {
  const sets = await db
    .select({ setId: tcgSet.id, gameKey: tcgSet.gameKey, name: tcgSet.name })
    .from(tcgSet)
    .where(eq(tcgSet.status, "active"));
  return buildScopeSetIndex(sets);
}

export type ScopeTalkPiece = { text: string; segmentId: string | null };
export type ScopeTalkIndexes = { sets: ScopeSetIndex; cards: CardNameIndex | null };

let setCache: { index: ScopeSetIndex; at: number } | null = null;

/** The set lookup, reloaded at most every 30 minutes (new sets arrive with the daily catalog import). */
export async function cachedScopeSetIndex(db: Database): Promise<ScopeSetIndex> {
  if (setCache && Date.now() - setCache.at < 1_800_000) return setCache.index;
  setCache = { index: await loadScopeSetIndex(db), at: Date.now() };
  return setCache.index;
}

let cardCache: { index: CardNameIndex; at: number } | null = null;

async function cachedCardNameIndex(db: Database): Promise<CardNameIndex> {
  if (cardCache && Date.now() - cardCache.at < 1_800_000) return cardCache.index;
  cardCache = { index: await loadCardNameIndex(db), at: Date.now() };
  return cardCache.index;
}

/** Set and card lookups; `cards` when the caller already loaded the card index. */
export async function loadScopeTalkIndexes(db: Database, cards?: CardNameIndex | null): Promise<ScopeTalkIndexes> {
  const [sets, cardIndex] = await Promise.all([cachedScopeSetIndex(db), cards === undefined ? cachedCardNameIndex(db) : cards]);
  return { sets, cards: cardIndex };
}

/** For tests: forget cached lookups. */
export function resetScopeTalkCaches() {
  setCache = null;
  cardCache = null;
  tableSeen = false;
  tableCheckedAt = 0;
}

/**
 * Reads scoped talk from text seen at ingest (full web posts, show notes,
 * descriptions, transcript windows) that is not stored in full. Never fails
 * the ingest: a failure is logged as zero statements. Run inside the
 * ingest's platform-context transaction.
 */
export async function storeScopeTalkAtIngest(
  tx: Database,
  input: { contentId: string; publishedAt: Date; texts: Array<string | null | undefined>; cards: CardNameIndex | null; title?: string | null },
): Promise<number> {
  try {
    if (!(await scopeTalkReady(tx))) return 0;
    const indexes = await loadScopeTalkIndexes(tx, input.cards);
    const pieces = [input.title, ...input.texts]
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .map((text) => ({ text, segmentId: null }));
    // A savepoint, so a failed insert never aborts the ingest transaction.
    return await tx.transaction((inner) =>
      storeScopeTalk(inner as unknown as Database, { contentId: input.contentId, publishedAt: input.publishedAt, pieces, indexes, keepExisting: true }),
    );
  } catch {
    return 0;
  }
}

/** Statements in the pieces of one post. Pure. The same statement in two pieces counts once. */
export function planScopeTalk(
  contentId: string,
  pieces: ScopeTalkPiece[],
  indexes: ScopeTalkIndexes,
  publishedAt: Date,
): Array<ScopeTalkStatement & { id: string; segmentId: string | null }> {
  const seen = new Set<string>();
  const out: Array<ScopeTalkStatement & { id: string; segmentId: string | null }> = [];
  for (const piece of pieces) {
    for (const row of extractScopeTalk(piece.text, indexes.sets, indexes.cards, publishedAt)) {
      const key = [row.setId, row.scope, row.productType, row.grade, row.rarity, row.cardName, row.sentiment].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...row, segmentId: piece.segmentId, id: stableSourceId("mst", [contentId, SCOPE_TALK_VERSION, key]) });
    }
  }
  return out;
}

/**
 * Replaces the post's statements with those read from `pieces`. Run inside a
 * platform-context transaction. Returns how many statements were stored.
 */
export async function storeScopeTalk(
  tx: Database,
  input: { contentId: string; publishedAt: Date; pieces: ScopeTalkPiece[]; indexes?: ScopeTalkIndexes; keepExisting?: boolean },
): Promise<number> {
  if (!(await scopeTalkReady(tx))) return 0;
  const indexes = input.indexes ?? (await loadScopeTalkIndexes(tx));
  const planned = planScopeTalk(input.contentId, input.pieces, indexes, input.publishedAt);
  if (!input.keepExisting) await tx.delete(marketScopeTalk).where(eq(marketScopeTalk.contentId, input.contentId));
  if (planned.length === 0) return 0;
  await tx
    .insert(marketScopeTalk)
    .values(
      planned.map((row) => ({
        id: row.id,
        contentId: input.contentId,
        segmentId: row.segmentId,
        setId: row.setId,
        scope: row.scope,
        productType: row.productType,
        grade: row.grade,
        rarity: row.rarity,
        cardName: row.cardName,
        sentiment: row.sentiment,
        clause: row.clause,
        horizonDays: row.horizonDays,
        horizonPhrase: row.horizonPhrase,
        extractionVersion: SCOPE_TALK_VERSION,
      })),
    )
    .onConflictDoNothing();
  return planned.length;
}

/**
 * Reads the post's stored text (title, summary, excerpt and segment
 * excerpts) and replaces its statements. Statements read from full
 * transcript windows at ingest are kept: stored excerpts are shorter than
 * the windows they came from, so they are only added to.
 */
export async function extractScopeTalkForContent(
  db: Database,
  contentId: string,
  indexes?: ScopeTalkIndexes,
): Promise<number> {
  if (!(await scopeTalkReady(db))) return 0;
  const [content] = await db.select().from(sourceContent).where(eq(sourceContent.id, contentId)).limit(1);
  if (!content) return 0;
  indexes ??= await loadScopeTalkIndexes(db);
  const segments = await db
    .select({ id: sourceContentSegment.id, excerpt: sourceContentSegment.excerpt })
    .from(sourceContentSegment)
    .where(eq(sourceContentSegment.contentId, contentId));
  const pieces: ScopeTalkPiece[] = [
    { text: [content.title, content.summary, content.excerpt].filter(Boolean).join(". "), segmentId: null },
    ...segments.filter((row) => row.excerpt).map((row) => ({ text: row.excerpt!, segmentId: row.id })),
  ];
  return storeScopeTalk(db, { contentId, publishedAt: content.publishedAt, pieces, indexes, keepExisting: true });
}

/** Bumped when the reader changes; restarts the walk over stored posts. */
export const SCOPE_TALK_RESCAN_KEY = SCOPE_TALK_VERSION;
export const SCOPE_TALK_RESCAN_TRIGGER = "scope_talk_rescan";
export const SCOPE_TALK_RESCAN_DEFAULT_LIMIT = 500;
/** Only posts this recent can still move sentiment (the longest time frame read is two years, most fade within 90 days). */
export const SCOPE_TALK_RESCAN_LOOKBACK_DAYS = 365;

export type ScopeTalkRescanReport = { scanned: number; statements: number; failed: number; skipped?: "table_missing" };

async function readCursor(db: Database): Promise<{ publishedAt: string; id: string } | null> {
  const [row] = await db
    .select({ checkpoint: providerSyncRun.checkpoint })
    .from(providerSyncRun)
    .where(and(eq(providerSyncRun.providerKey, "web_feed"), eq(providerSyncRun.trigger, SCOPE_TALK_RESCAN_TRIGGER)))
    .orderBy(desc(providerSyncRun.startedAt), desc(providerSyncRun.id))
    .limit(1);
  const checkpoint = row?.checkpoint ?? {};
  if (checkpoint.key !== SCOPE_TALK_RESCAN_KEY) return null;
  const publishedAt = typeof checkpoint.published_at === "string" ? checkpoint.published_at : null;
  const id = typeof checkpoint.content_id === "string" ? checkpoint.content_id : null;
  return publishedAt && id ? { publishedAt, id } : null;
}

/**
 * Reads scoped talk out of posts stored before this reader existed, newest
 * year only, oldest first, at most `limit` per run behind a cursor kept in a
 * provider_sync_run checkpoint (provider `web_feed`, trigger
 * `scope_talk_rescan`). Database only.
 */
export async function rescanScopeTalk(
  db: Database,
  options: { limit?: number; now?: Date } = {},
): Promise<ScopeTalkRescanReport> {
  const report: ScopeTalkRescanReport = { scanned: 0, statements: 0, failed: 0 };
  if (!(await withPlatformContext(db, (tx) => scopeTalkReady(tx)))) return { ...report, skipped: "table_missing" };
  const limit = Math.max(1, Math.min(options.limit ?? SCOPE_TALK_RESCAN_DEFAULT_LIMIT, 2_000));
  const startedAt = options.now ?? new Date();
  const since = new Date(startedAt.getTime() - SCOPE_TALK_RESCAN_LOOKBACK_DAYS * 86_400_000);
  const cursor = await withPlatformContext(db, (tx) => readCursor(tx));
  const rows = await withPlatformContext(db, async (tx) =>
    rowsOf<{ id: string; published_at: string | Date }>(
      await tx.execute(sql`
        SELECT sc.id, sc.published_at
        FROM source_content sc
        WHERE sc.created_at < ${startedAt.toISOString()}::timestamptz
          AND sc.published_at > ${since.toISOString()}::timestamptz
          ${cursor ? sql`AND (sc.published_at, sc.id) > (${cursor.publishedAt}::timestamptz, ${cursor.id})` : sql``}
        ORDER BY sc.published_at, sc.id
        LIMIT ${limit}
      `),
    ),
  );
  if (rows.length === 0) return report;
  const indexes = await withPlatformContext(db, (tx) => loadScopeTalkIndexes(tx));
  for (const row of rows) {
    report.scanned += 1;
    const stored = await withPlatformContext(db, (tx) => extractScopeTalkForContent(tx, row.id, indexes)).catch(() => null);
    if (stored == null) report.failed += 1;
    else report.statements += stored;
  }
  const last = rows.at(-1)!;
  const lastPublishedAt =
    last.published_at instanceof Date ? last.published_at.toISOString() : new Date(last.published_at).toISOString();
  await withPlatformContext(db, (tx) =>
    tx.insert(providerSyncRun).values({
      id: `pst_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      providerKey: "web_feed",
      mode: "live",
      trigger: SCOPE_TALK_RESCAN_TRIGGER,
      status: "completed",
      limitCount: limit,
      receivedCount: report.statements,
      startedAt,
      completedAt: new Date(),
      checkpoint: {
        key: SCOPE_TALK_RESCAN_KEY,
        published_at: lastPublishedAt,
        content_id: last.id,
        scanned: report.scanned,
        statements: report.statements,
        failed: report.failed,
      },
    }),
  );
  return report;
}
