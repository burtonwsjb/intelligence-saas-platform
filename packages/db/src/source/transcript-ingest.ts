/**
 * Turns a YouTube video's transcript into card mentions, so creator calls can
 * name the card they are about ("Charizard ex 199 from Obsidian Flames")
 * instead of only the video title.
 *
 * Retention: full transcripts are never stored. Only the ~60s windows that
 * contain a detected catalog card name are kept, as one
 * source_content_segment per window with a bounded excerpt (at most
 * TRANSCRIPT_EXCERPT_MAX_CHARS, around the mentions) and `t=<seconds>`
 * start/end references. Every other window is discarded after detection.
 *
 * Checked tracking: source_content is immutable (UPDATE is refused by
 * trigger), so neither `transcript_available` nor content metadata can be set
 * after ingest. Each video's check is recorded instead as one
 * provider_sync_run row (provider `youtube`, trigger `transcript`, id
 * `ptx_<content id>`), whose checkpoint carries the outcome and transcript
 * availability. A completed or skipped (unavailable) row is never fetched
 * again; a failed one is retried after 24 hours, at most three attempts.
 * Every claimed row reserves the fetcher's worst-case request count in
 * `limit_count`, which is what the daily request budget sums.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { extractCreatorCallsFromContent } from "../creator/ingest.js";
import { analyzeSourceSentiment } from "../providers/sentiment.js";
import { getProviderRuntime } from "../providers/runtime.js";
import {
  chunkTranscriptCues,
  type TranscriptFetcher,
  type TranscriptResult,
  type TranscriptWindow,
} from "../providers/transcripts.js";
import { resolveSourceMention } from "../resolution/resolve.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun, sourceSentiment } from "../schema/provider.js";
import { sourceContent, sourceContentSegment, sourceMention } from "../schema/source.js";
import { detectCardMentions, loadCardNameIndex, type CardNameIndex, type DetectedCardMention } from "./card-detect.js";
import { boundSourceExcerpt, excerptHash, normalizeMentionText, stableSourceId } from "./identity.js";

export const TRANSCRIPT_EXTRACTOR_VERSION = "source.transcript.v1";
export const TRANSCRIPT_WINDOW_MS = 60_000;
export const TRANSCRIPT_EXCERPT_MAX_CHARS = 480;
export const TRANSCRIPT_CHECK_ID_PREFIX = "ptx_";
export const TRANSCRIPT_SYNC_TRIGGER = "transcript";
export const TRANSCRIPT_MAX_ATTEMPTS = 3;
export const TRANSCRIPT_BACKFILL_MAX_VIDEOS_PER_RUN = 10;
const SNIPPET_CONTEXT_CHARS = 100;
const MAX_MENTIONS_PER_VIDEO = 60;

export type TranscriptIngestOutcome =
  | "ingested"
  | "no_mentions"
  | "unavailable"
  | "rate_limited"
  | "error"
  | "already_checked"
  | "budget_exhausted"
  | "not_eligible";

export type TranscriptIngestReport = {
  contentId: string;
  outcome: TranscriptIngestOutcome;
  reason: string | null;
  windows: number;
  segments: number;
  mentions: number;
  callsCreated: number;
};

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

export function transcriptCheckId(contentId: string) {
  return `${TRANSCRIPT_CHECK_ID_PREFIX}${contentId}`;
}

function seconds(ms: number, round: (n: number) => number) {
  return `t=${Math.max(0, round(ms / 1000))}`;
}

/**
 * A bounded excerpt of a window: the text around each mention (merged when
 * they overlap, joined with " … "), stopping before TRANSCRIPT_EXCERPT_MAX_CHARS.
 */
export function boundedWindowExcerpt(text: string, mentions: Array<{ start: number; end: number }>): string {
  const ranges = mentions
    .map((mention) => {
      let from = Math.max(0, mention.start - SNIPPET_CONTEXT_CHARS);
      let to = Math.min(text.length, mention.end + SNIPPET_CONTEXT_CHARS);
      while (from > 0 && from < mention.start && !/\s/.test(text[from - 1]!)) from += 1;
      while (to < text.length && to > mention.end && !/\s/.test(text[to]!)) to -= 1;
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  let excerpt = "";
  for (const range of merged) {
    const piece = text.slice(range.from, range.to).trim();
    const next = excerpt ? `${excerpt} … ${piece}` : piece;
    if (next.length > TRANSCRIPT_EXCERPT_MAX_CHARS) {
      if (!excerpt) excerpt = piece.slice(0, TRANSCRIPT_EXCERPT_MAX_CHARS).trim();
      break;
    }
    excerpt = next;
  }
  return excerpt;
}

function cueOffsetAt(window: TranscriptWindow, charIndex: number): number {
  let offset = window.startMs;
  for (const cue of window.cueStarts) {
    if (cue.charStart > charIndex) break;
    offset = cue.offsetMs;
  }
  return offset;
}

export type PlannedTranscriptSegment = {
  id: string;
  startRef: string;
  endRef: string;
  excerpt: string;
  startMs: number;
  endMs: number;
  mentions: Array<DetectedCardMention & { id: string; rawEntityText: string; normalized: string; offsetMs: number }>;
};

/** Windows with at least one card mention, as the segments and mentions to store. Pure. */
export function planTranscriptSegments(
  contentId: string,
  windows: TranscriptWindow[],
  index: CardNameIndex,
): PlannedTranscriptSegment[] {
  const planned: PlannedTranscriptSegment[] = [];
  let total = 0;
  for (const window of windows) {
    if (total >= MAX_MENTIONS_PER_VIDEO) break;
    const detected = detectCardMentions(window.text, index).slice(0, MAX_MENTIONS_PER_VIDEO - total);
    if (detected.length === 0) continue;
    const startRef = seconds(window.startMs, Math.floor);
    const endRef = seconds(window.endMs, Math.ceil);
    const segmentId = stableSourceId("ssg", [contentId, "timestamp_range", startRef, endRef, TRANSCRIPT_EXTRACTOR_VERSION]);
    const excerpt = boundedWindowExcerpt(window.text, detected);
    const mentions = detected.map((mention) => {
      const rawEntityText = mention.collectorNumber ? `${mention.name} ${mention.collectorNumber}` : mention.name;
      const normalized = normalizeMentionText(rawEntityText);
      return {
        ...mention,
        id: stableSourceId("smn", [contentId, normalized, "other", TRANSCRIPT_EXTRACTOR_VERSION, startRef]),
        rawEntityText,
        normalized,
        offsetMs: cueOffsetAt(window, mention.start),
      };
    });
    total += mentions.length;
    planned.push({ id: segmentId, startRef, endRef, excerpt, startMs: window.startMs, endMs: window.endMs, mentions });
  }
  return planned;
}

type Claim = { claimed: true } | { claimed: false; outcome: "already_checked" | "budget_exhausted" | "not_eligible" };

/**
 * Records that this video is being checked and reserves its requests in the
 * daily budget, in one short committed transaction before any HTTP request.
 */
async function claimTranscriptCheck(
  db: Database,
  input: { contentId: string; reserve: number; budget: number | null; provider: string },
): Promise<Claim> {
  return withPlatformContext<Claim>(db, async (tx) => {
    const [content] = await tx
      .select({ sourceType: sourceContent.sourceType, contentType: sourceContent.contentType })
      .from(sourceContent)
      .where(eq(sourceContent.id, input.contentId))
      .limit(1);
    if (!content || content.sourceType !== "youtube" || content.contentType !== "video") {
      return { claimed: false, outcome: "not_eligible" };
    }
    // Serializes claims across worker replicas so the daily budget is exact.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('transcript.backfill.v1'))`);
    if (input.budget != null) {
      const used = rowsOf<{ used: number | string | null }>(
        await tx.execute(sql`
          SELECT COALESCE(SUM(limit_count), 0) AS used FROM provider_sync_run
          WHERE provider_key = 'youtube' AND "trigger" = ${TRANSCRIPT_SYNC_TRIGGER}
            AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`),
      );
      if (Number(used[0]?.used ?? 0) + input.reserve > input.budget) {
        return { claimed: false, outcome: "budget_exhausted" };
      }
    }
    const id = transcriptCheckId(input.contentId);
    const claimed = rowsOf<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO provider_sync_run (id, provider_key, mode, "trigger", status, limit_count, checkpoint)
        VALUES (${id}, 'youtube', 'live', ${TRANSCRIPT_SYNC_TRIGGER}, 'started', ${input.reserve},
          jsonb_build_object('content_id', ${input.contentId}::text, 'transcript_provider', ${input.provider}::text, 'attempts', 1))
        ON CONFLICT (id) DO UPDATE SET
          status = 'started',
          started_at = now(),
          completed_at = NULL,
          error_class = NULL,
          limit_count = EXCLUDED.limit_count,
          received_count = 0,
          checkpoint = jsonb_build_object(
            'content_id', ${input.contentId}::text,
            'transcript_provider', ${input.provider}::text,
            'attempts', COALESCE((provider_sync_run.checkpoint->>'attempts')::int, 0) + 1)
        WHERE provider_sync_run.status NOT IN ('completed', 'skipped')
          AND provider_sync_run.started_at <= now() - interval '24 hours'
          AND COALESCE((provider_sync_run.checkpoint->>'attempts')::int, 0) < ${TRANSCRIPT_MAX_ATTEMPTS}
        RETURNING id`),
    );
    return claimed.length > 0 ? { claimed: true } : { claimed: false, outcome: "already_checked" };
  });
}

async function finishTranscriptCheck(
  db: Database,
  input: {
    contentId: string;
    status: "completed" | "skipped" | "failed";
    errorClass: string | null;
    receivedCount: number;
    checkpoint: Record<string, unknown>;
  },
) {
  await withPlatformContext(db, async (tx) => {
    await tx
      .update(providerSyncRun)
      .set({
        status: input.status,
        errorClass: input.errorClass,
        receivedCount: input.receivedCount,
        completedAt: new Date(),
        checkpoint: sql`${providerSyncRun.checkpoint} || ${JSON.stringify(input.checkpoint)}::jsonb`,
      })
      .where(eq(providerSyncRun.id, transcriptCheckId(input.contentId)));
  });
}

/**
 * Fetches one YouTube video's transcript and stores the card mentions in it
 * (see the file comment for what is kept). New mentions are resolved and the
 * content's creator calls are extracted again, so calls can bind to the
 * printing a creator names. Idempotent: ids are stable, inserts skip
 * existing rows, call fingerprints dedupe, and a checked video is not fetched
 * again.
 */
export async function ingestTranscriptForContent(
  db: Database,
  contentId: string,
  fetcher: TranscriptFetcher,
  options: { index?: CardNameIndex; budget?: number | null; lang?: string } = {},
): Promise<TranscriptIngestReport> {
  const report: TranscriptIngestReport = {
    contentId,
    outcome: "already_checked",
    reason: null,
    windows: 0,
    segments: 0,
    mentions: 0,
    callsCreated: 0,
  };
  const claim = await claimTranscriptCheck(db, {
    contentId,
    reserve: fetcher.maxRequestsPerVideo,
    budget: options.budget ?? null,
    provider: fetcher.provider,
  });
  if (!claim.claimed) return { ...report, outcome: claim.outcome };

  const [content] = await withPlatformContext(db, async (tx) =>
    tx.select().from(sourceContent).where(eq(sourceContent.id, contentId)).limit(1),
  );
  let result: TranscriptResult;
  try {
    result = await fetcher.fetch(content!.externalContentId, { lang: options.lang ?? "en" });
  } catch {
    result = { status: "error", reason: "fetcher_failed" };
  }

  if (result.status === "unavailable") {
    await finishTranscriptCheck(db, {
      contentId,
      status: "skipped",
      errorClass: null,
      receivedCount: 0,
      checkpoint: { outcome: "unavailable", reason: result.reason ?? null, transcript_available: false },
    });
    return { ...report, outcome: "unavailable", reason: result.reason ?? null };
  }
  if (result.status === "rate_limited" || result.status === "error") {
    await finishTranscriptCheck(db, {
      contentId,
      status: "failed",
      errorClass: result.reason,
      receivedCount: 0,
      checkpoint: { outcome: result.status, reason: result.reason },
    });
    return { ...report, outcome: result.status, reason: result.reason };
  }

  const transcript = result;
  try {
    const stored = await withPlatformContext(db, async (tx) => {
      const index = options.index ?? (await loadCardNameIndex(tx));
      const windows = chunkTranscriptCues(transcript.cues, TRANSCRIPT_WINDOW_MS);
      const planned = planTranscriptSegments(contentId, windows, index);
      let mentionCount = 0;
      for (const segment of planned) {
        const excerpt = boundSourceExcerpt(segment.excerpt);
        await tx
          .insert(sourceContentSegment)
          .values({
            id: segment.id,
            contentId,
            kind: "timestamp_range",
            startRef: segment.startRef,
            endRef: segment.endRef,
            excerpt,
            excerptHash: excerptHash(excerpt),
            metadata: {
              source: "transcript",
              transcript_provider: fetcher.provider,
              transcript_lang: transcript.lang,
              track_kind: transcript.trackKind,
              window_start_ms: segment.startMs,
              window_end_ms: segment.endMs,
              extractor_version: TRANSCRIPT_EXTRACTOR_VERSION,
            },
          })
          .onConflictDoNothing();
        for (const mention of segment.mentions) {
          const inserted = await tx
            .insert(sourceMention)
            .values({
              id: mention.id,
              contentId,
              segmentId: segment.id,
              rawEntityText: mention.rawEntityText,
              normalizedEntityText: mention.normalized,
              mentionContext: "other",
              sentiment: "unknown",
              extractionVersion: TRANSCRIPT_EXTRACTOR_VERSION,
              metadata: {
                printing_id: null,
                resolution_status: "unresolved",
                transcript: {
                  card_name: mention.name,
                  matched_text: mention.matchedText,
                  collector_number: mention.collectorNumber,
                  set_key: mention.set?.key ?? null,
                  set_name: mention.set?.name ?? null,
                  game_key: mention.gameKey,
                  offset_ms: mention.offsetMs,
                },
              },
            })
            .onConflictDoNothing()
            .returning({ id: sourceMention.id });
          if (inserted.length === 0) continue;
          mentionCount += 1;
          const analysis = analyzeSourceSentiment({
            text: `${content!.title ?? ""} ${segment.excerpt} ${mention.rawEntityText}`,
            mention_context: "other",
          });
          await tx
            .insert(sourceSentiment)
            .values({
              id: stableSourceId("sst", [mention.id, analysis.analyzer_version]),
              mentionId: mention.id,
              analyzerVersion: analysis.analyzer_version,
              direction: analysis.direction,
              strength: analysis.strength,
              confidence: analysis.confidence == null ? null : String(analysis.confidence),
              subject: analysis.subject,
              entityKind: analysis.entity_kind,
              timeHorizon: analysis.time_horizon,
              marketRelevance: analysis.market_relevance,
              excitement: analysis.excitement,
              purchaseIntent: analysis.purchase_intent,
              priceExpectation: analysis.price_expectation,
              creatorRecommendation: analysis.creator_recommendation,
              marketConcern: analysis.market_concern,
              evidence: analysis.evidence,
            })
            .onConflictDoNothing();
          try {
            await resolveSourceMention(tx, mention.id);
          } catch {
            // Resolution failures stay in entity_resolution_attempt; the mention is kept.
          }
        }
      }
      let callsCreated = 0;
      if (mentionCount > 0) {
        const calls = await extractCreatorCallsFromContent(tx, contentId);
        callsCreated = calls.filter((row) => row.status === "processed").length;
      }
      return { windows: windows.length, segments: planned.length, mentions: mentionCount, callsCreated };
    });
    const outcome = stored.segments > 0 ? "ingested" : "no_mentions";
    await finishTranscriptCheck(db, {
      contentId,
      status: "completed",
      errorClass: null,
      receivedCount: stored.mentions,
      checkpoint: {
        outcome,
        transcript_available: true,
        transcript_lang: transcript.lang,
        track_kind: transcript.trackKind,
        windows: stored.windows,
        segments: stored.segments,
        mentions: stored.mentions,
        calls_created: stored.callsCreated,
        extractor_version: TRANSCRIPT_EXTRACTOR_VERSION,
      },
    });
    return { ...report, outcome, ...stored };
  } catch (error) {
    await finishTranscriptCheck(db, {
      contentId,
      status: "failed",
      errorClass: "ingest_failed",
      receivedCount: 0,
      checkpoint: { outcome: "error", reason: "ingest_failed" },
    });
    throw error;
  }
}

export type TranscriptBackfillReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  considered: number;
  checked: number;
  ingested: number;
  noMentions: number;
  unavailable: number;
  failed: number;
  segments: number;
  mentions: number;
  callsCreated: number;
};

/**
 * Checks the newest YouTube videos that have not been checked yet, at most
 * `maxVideos` and within the daily request `budget`. Videos of creators an
 * operator excluded are skipped. Stops for the rest of the day once the
 * provider rate-limits or blocks a request.
 */
export async function runTranscriptBackfillBatch(
  db: Database,
  fetcher: TranscriptFetcher,
  input: { budget: number; maxVideos?: number },
): Promise<TranscriptBackfillReport> {
  const report: TranscriptBackfillReport = {
    status: "completed",
    reason: null,
    considered: 0,
    checked: 0,
    ingested: 0,
    noMentions: 0,
    unavailable: 0,
    failed: 0,
    segments: 0,
    mentions: 0,
    callsCreated: 0,
  };
  const maxVideos = Math.max(
    0,
    Math.min(input.maxVideos ?? TRANSCRIPT_BACKFILL_MAX_VIDEOS_PER_RUN, TRANSCRIPT_BACKFILL_MAX_VIDEOS_PER_RUN),
  );
  if (input.budget < fetcher.maxRequestsPerVideo || maxVideos === 0) {
    return { ...report, status: "skipped", reason: "no_budget" };
  }
  const setup = await withPlatformContext(db, async (tx) => {
    if ((await getProviderRuntime(tx, "youtube"))?.paused) return { skip: "paused" as const };
    const blocked = rowsOf<{ blocked: boolean }>(
      await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM provider_sync_run
          WHERE provider_key = 'youtube' AND "trigger" = ${TRANSCRIPT_SYNC_TRIGGER}
            AND error_class IN ('blocked', 'rate_limited')
            AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date
        ) AS blocked`),
    );
    if (blocked[0]?.blocked) return { skip: "blocked_today" as const };
    const candidates = rowsOf<{ id: string }>(
      await tx.execute(sql`
        SELECT sc.id FROM source_content sc
        WHERE sc.source_type = 'youtube' AND sc.content_type = 'video'
          AND NOT EXISTS (
            SELECT 1 FROM provider_sync_run r
            WHERE r.id = ${TRANSCRIPT_CHECK_ID_PREFIX}::text || sc.id
              AND (r.status IN ('completed', 'skipped')
                OR r.started_at > now() - interval '24 hours'
                OR COALESCE((r.checkpoint->>'attempts')::int, 0) >= ${TRANSCRIPT_MAX_ATTEMPTS}))
          AND NOT EXISTS (
            SELECT 1 FROM discovered_creator dc
            WHERE dc.source_account_id = sc.account_id AND dc.relevance_state = 'excluded')
          AND NOT EXISTS (
            SELECT 1 FROM creator_source_account csa
            WHERE csa.source_account_id = sc.account_id
              AND (SELECT te.trust_state FROM creator_trust_event te
                   WHERE te.creator_id = csa.creator_id
                   ORDER BY te.created_at DESC LIMIT 1) = 'excluded')
        ORDER BY sc.published_at DESC, sc.id
        LIMIT ${maxVideos}`),
    );
    if (candidates.length === 0) return { skip: "nothing_to_check" as const };
    return { candidates: candidates.map((row) => row.id), index: await loadCardNameIndex(tx) };
  });
  if ("skip" in setup) return { ...report, status: "skipped", reason: setup.skip ?? null };

  for (const contentId of setup.candidates) {
    report.considered += 1;
    const one = await ingestTranscriptForContent(db, contentId, fetcher, { index: setup.index, budget: input.budget });
    if (one.outcome === "budget_exhausted") {
      return { ...report, status: "stopped", reason: "budget_exhausted" };
    }
    if (one.outcome === "already_checked" || one.outcome === "not_eligible") continue;
    report.checked += 1;
    report.segments += one.segments;
    report.mentions += one.mentions;
    report.callsCreated += one.callsCreated;
    if (one.outcome === "ingested") report.ingested += 1;
    else if (one.outcome === "no_mentions") report.noMentions += 1;
    else if (one.outcome === "unavailable") report.unavailable += 1;
    else report.failed += 1;
    if (one.outcome === "rate_limited") {
      return { ...report, status: "stopped", reason: one.reason ?? "rate_limited" };
    }
  }
  return report;
}
