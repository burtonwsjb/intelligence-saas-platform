/**
 * Twelve-month YouTube backfill for monitored channels (operator seeds
 * first), so each creator's accuracy rests on a year of calls rather than
 * whatever monitoring saw since it started.
 *
 * Official Data API only, metadata only: the channel's uploads playlist is
 * paged back (playlistItems.list, 50 per request), then videos.list returns
 * titles and descriptions. No captions or media are downloaded. Each video is
 * stored as ordinary source content, catalog card names in the title and
 * description become bounded `paragraph` segments and mentions (the same
 * card detector as transcripts and websites; descriptions are never stored
 * whole, only the existing 500-character summary and ≤480-character
 * excerpts around card names), and creator calls are extracted.
 *
 * Budget: every request is reserved in the shared YouTube daily data bucket
 * (YOUTUBE_DISCOVERY_DATA_REQUESTS_PER_DAY, default 200) before it is sent,
 * and the backfill itself may use at most YOUTUBE_BACKFILL_REQUESTS_PER_DAY of
 * them (default 60, Pacific day), so monitoring and discovery keep the rest.
 *
 * State: no new table. Each channel run is one provider_sync_run row
 * (provider `youtube`, trigger `youtube_backfill`, id `pyb_…`) whose
 * `limit_count` is the requests it reserved/used (what the daily cap sums)
 * and whose checkpoint carries the channel's resume state (uploads playlist,
 * next page token, cutoff, totals). The newest row per channel is its state,
 * so a run that stops on the budget resumes on the next day's run.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { extractAssetCallsFromContent } from "../creator/assets.js";
import { extractCreatorCallsFromContent } from "../creator/ingest.js";
import { providerCredentialStatus, resolveProviderMode } from "../providers/catalog.js";
import { budgetedDiscoveryTransport, DiscoveryBudgetError } from "../providers/discovery-budget.js";
import { createLiveYoutubeProvider, type LiveYoutubeSourceProvider } from "../providers/live-social.js";
import { getProviderRuntime } from "../providers/runtime.js";
import { ProviderHttpError, type HttpTransport } from "../providers/transport.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceIngest } from "../schema/source.js";
import { loadCardNameIndex, type CardNameIndex } from "./card-detect.js";
import { storeCardMentionSegments, type CardMentionSegment } from "./card-mentions.js";
import type { SourceContentRecordInput } from "./identity.js";
import { ingestSourceContentRecord } from "./ingest.js";
import { planWebPostSegments } from "./web-feed-ingest.js";

export const YOUTUBE_BACKFILL_TRIGGER = "youtube_backfill";
export const YOUTUBE_BACKFILL_RUN_PREFIX = "pyb_";
export const YOUTUBE_BACKFILL_EXTRACTOR_VERSION = "source.youtube_description.v1";
export const YOUTUBE_BACKFILL_MAX_CHANNELS_PER_RUN = 3;
/** Pages per channel per run; a page costs two requests (playlistItems + videos). */
export const YOUTUBE_BACKFILL_MAX_PAGES_PER_RUN = 4;
/** Hard stop per channel: 20 pages is 1,000 uploads. */
export const YOUTUBE_BACKFILL_MAX_PAGES_PER_CHANNEL = 20;
export const DEFAULT_YOUTUBE_BACKFILL_REQUESTS_PER_DAY = 60;
export const YOUTUBE_BACKFILL_MAX_DAYS = 400;
/** A channel run younger than this is not claimed again (overlapping replicas). */
export const YOUTUBE_BACKFILL_CLAIM_MINUTES = 30;
const MAX_MENTIONS_PER_VIDEO = 40;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const value = env[key];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${key} configuration.`);
  }
  return parsed;
}

/**
 * YOUTUBE_BACKFILL_DAYS (0 or unset: off; recommended 365) and
 * YOUTUBE_BACKFILL_REQUESTS_PER_DAY (default 60).
 */
export function youtubeBackfillConfig(env: NodeJS.ProcessEnv = process.env) {
  const days = intEnv(env, "YOUTUBE_BACKFILL_DAYS", 0, YOUTUBE_BACKFILL_MAX_DAYS);
  const budget = intEnv(env, "YOUTUBE_BACKFILL_REQUESTS_PER_DAY", DEFAULT_YOUTUBE_BACKFILL_REQUESTS_PER_DAY, 10_000);
  return { enabled: days > 0 && budget > 0, days, budget };
}

/**
 * Description text for card detection: links removed (a sponsor or shop URL
 * naming a card is not the creator's call) and every line its own paragraph.
 */
export function youtubeDescriptionText(description: string): string {
  return description
    .slice(0, 10_000)
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Segments and mentions for one video's title and description. Pure. */
export function planYoutubeVideoSegments(
  contentId: string,
  title: string | null,
  description: string,
  index: CardNameIndex,
): CardMentionSegment[] {
  return planWebPostSegments(contentId, title, youtubeDescriptionText(description), index, {
    extractorVersion: YOUTUBE_BACKFILL_EXTRACTOR_VERSION,
    source: "youtube_description",
    maxMentions: MAX_MENTIONS_PER_VIDEO,
  });
}

export type YoutubeBackfillState = {
  channel_id: string;
  cutoff: string;
  uploads_playlist_id: string | null;
  page_token: string | null;
  done: boolean;
  outcome: string | null;
  pages: number;
  videos_seen: number;
  videos_stored: number;
  mentions: number;
  calls_created: number;
};

export function initialBackfillState(channelId: string, now: Date, days: number): YoutubeBackfillState {
  return {
    channel_id: channelId,
    cutoff: new Date(now.getTime() - days * 86_400_000).toISOString(),
    uploads_playlist_id: null,
    page_token: null,
    done: false,
    outcome: null,
    pages: 0,
    videos_seen: 0,
    videos_stored: 0,
    mentions: 0,
    calls_created: 0,
  };
}

function stateFrom(value: unknown, channelId: string, now: Date, days: number): YoutubeBackfillState {
  const raw = asRecord(value);
  const base = initialBackfillState(channelId, now, days);
  if (raw.channel_id !== channelId || typeof raw.cutoff !== "string") return base;
  const num = (key: keyof YoutubeBackfillState) => (Number.isFinite(Number(raw[key])) ? Number(raw[key]) : 0);
  return {
    channel_id: channelId,
    cutoff: raw.cutoff,
    uploads_playlist_id: typeof raw.uploads_playlist_id === "string" ? raw.uploads_playlist_id : null,
    page_token: typeof raw.page_token === "string" ? raw.page_token : null,
    done: raw.done === true,
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
    pages: num("pages"),
    videos_seen: num("videos_seen"),
    videos_stored: num("videos_stored"),
    mentions: num("mentions"),
    calls_created: num("calls_created"),
  };
}

export type YoutubeBackfillReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  channels: number;
  finished: number;
  requests: number;
  pages: number;
  videos: number;
  stored: number;
  mentions: number;
  callsCreated: number;
};

function emptyReport(): YoutubeBackfillReport {
  return { status: "completed", reason: null, channels: 0, finished: 0, requests: 0, pages: 0, videos: 0, stored: 0, mentions: 0, callsCreated: 0 };
}

type Candidate = { id: string; creator_id: string; external_account_id: string; checkpoint: unknown };

/**
 * Stores one backfilled video and its card mentions, then extracts the
 * content's card and product calls. One transaction. Idempotent: the content,
 * segment and mention ids are stable and call fingerprints dedupe.
 */
export async function ingestBackfilledVideo(
  db: Database,
  input: { record: SourceContentRecordInput; description: string; index: CardNameIndex },
): Promise<{ stored: boolean; mentions: number; callsCreated: number }> {
  const record: SourceContentRecordInput = {
    ...input.record,
    // A distinct observation id, so the record never collides with the same
    // video seen by discovery or monitoring (different engagement snapshot).
    provider_record_id: `${input.record.content.external_content_id}:backfill`,
    content: {
      ...input.record.content,
      metadata: { ...input.record.content.metadata, backfill: YOUTUBE_BACKFILL_EXTRACTOR_VERSION },
    },
  };
  return withPlatformContext(db, async (tx) => {
    const [existing] = await tx
      .select({ status: sourceIngest.processingStatus })
      .from(sourceIngest)
      .where(sql`${sourceIngest.sourceType} = 'youtube' AND ${sourceIngest.sourceRecordId} = ${record.provider_record_id}`)
      .limit(1);
    const ingested = await ingestSourceContentRecord(tx, record);
    const contentId = ingested.contentId!;
    const planned = planYoutubeVideoSegments(contentId, record.content.title ?? null, input.description, input.index);
    const { mentions } = await storeCardMentionSegments(tx, {
      contentId,
      contentTitle: record.content.title ?? null,
      extractionVersion: YOUTUBE_BACKFILL_EXTRACTOR_VERSION,
      hintsKey: "card_detect",
      segments: planned,
    });
    const stored = existing?.status !== "processed";
    let callsCreated = 0;
    if (stored || mentions > 0) {
      const cardCalls = await extractCreatorCallsFromContent(tx, contentId);
      const assetCalls = await extractAssetCallsFromContent(tx, contentId);
      callsCreated =
        cardCalls.filter((row) => row.status === "processed").length +
        assetCalls.filter((row) => row.status === "processed").length;
    }
    return { stored, mentions, callsCreated };
  });
}

async function claimChannelRun(
  db: Database,
  input: { candidate: Candidate; reserve: number; budget: number; state: YoutubeBackfillState },
): Promise<{ claimed: true; runId: string; reserve: number } | { claimed: false; reason: "budget_exhausted" | "already_running" }> {
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('youtube.backfill.v1'))`);
    const used = rowsOf<{ used: number | string | null }>(
      await tx.execute(sql`
        SELECT COALESCE(SUM(limit_count), 0) AS used FROM provider_sync_run
        WHERE provider_key = 'youtube' AND "trigger" = ${YOUTUBE_BACKFILL_TRIGGER}
          AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`),
    );
    const available = input.budget - Number(used[0]?.used ?? 0);
    // At least one full page (two requests), plus the uploads lookup when it is still unknown.
    const minimum = input.state.uploads_playlist_id ? 2 : 3;
    if (available < minimum) return { claimed: false, reason: "budget_exhausted" };
    const running = rowsOf<{ found: boolean }>(
      await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM provider_sync_run
          WHERE provider_key = 'youtube' AND "trigger" = ${YOUTUBE_BACKFILL_TRIGGER}
            AND checkpoint->>'channel_id' = ${input.candidate.external_account_id}
            AND status = 'started'
            AND started_at > now() - (${YOUTUBE_BACKFILL_CLAIM_MINUTES}::int * interval '1 minute')
        ) AS found`),
    );
    if (running[0]?.found) return { claimed: false, reason: "already_running" };
    const reserve = Math.min(input.reserve, available);
    const runId = `${YOUTUBE_BACKFILL_RUN_PREFIX}${createHash("sha256")
      .update(`${input.candidate.external_account_id}|${new Date().toISOString()}|${Math.random()}`)
      .digest("hex")
      .slice(0, 32)}`;
    await tx.insert(providerSyncRun).values({
      id: runId,
      providerKey: "youtube",
      mode: "live",
      trigger: YOUTUBE_BACKFILL_TRIGGER,
      status: "started",
      limitCount: reserve,
      checkpoint: { ...input.state, discovered_creator_id: input.candidate.id, creator_id: input.candidate.creator_id },
    });
    return { claimed: true, runId, reserve };
  });
}

async function saveRun(
  db: Database,
  runId: string,
  input: { status?: "started" | "completed" | "failed" | "skipped"; requests: number; received: number; state: YoutubeBackfillState; errorClass?: string | null },
) {
  await withPlatformContext(db, (tx) =>
    tx
      .update(providerSyncRun)
      .set({
        ...(input.status ? { status: input.status, completedAt: input.status === "started" ? null : new Date() } : {}),
        errorClass: input.errorClass ?? null,
        limitCount: input.requests,
        receivedCount: input.received,
        checkpoint: sql`${providerSyncRun.checkpoint} || ${JSON.stringify(input.state)}::jsonb`,
      })
      .where(eq(providerSyncRun.id, runId)),
  );
}

/** Whether the channel may still be read: provider not paused, creator not excluded. */
async function stillAllowed(db: Database, candidate: Candidate) {
  return withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, "youtube");
    if (!runtime?.enabled || runtime.paused) return false;
    const rows = rowsOf<{ blocked: boolean }>(
      await tx.execute(sql`
        SELECT (
          EXISTS (SELECT 1 FROM discovered_creator dc WHERE dc.id = ${candidate.id} AND dc.relevance_state <> 'monitored')
          OR (SELECT te.trust_state FROM creator_trust_event te WHERE te.creator_id = ${candidate.creator_id}
              ORDER BY te.created_at DESC LIMIT 1) = 'excluded'
        ) AS blocked`),
    );
    return rows[0]?.blocked !== true;
  });
}

/**
 * Backfills up to `maxChannels` monitored channels whose year is not done
 * yet: operator seeds first, then channels never started, then the least
 * recently advanced. Stops for the day once the backfill cap or the shared
 * data bucket is spent; the next day's run resumes from each channel's page.
 */
export async function runYoutubeBackfillBatch(
  db: Database,
  input: {
    provider: Pick<LiveYoutubeSourceProvider, "getUploadsPlaylistId" | "getUploadsPage" | "getVideoDetails">;
    requestCount: () => number;
    budget: number;
    days: number;
    now?: Date;
    maxChannels?: number;
    maxPagesPerRun?: number;
  },
): Promise<YoutubeBackfillReport> {
  const report = emptyReport();
  const now = input.now ?? new Date();
  const maxChannels = Math.max(0, Math.min(input.maxChannels ?? YOUTUBE_BACKFILL_MAX_CHANNELS_PER_RUN, YOUTUBE_BACKFILL_MAX_CHANNELS_PER_RUN));
  const maxPages = Math.max(1, Math.min(input.maxPagesPerRun ?? YOUTUBE_BACKFILL_MAX_PAGES_PER_RUN, YOUTUBE_BACKFILL_MAX_PAGES_PER_RUN));
  if (maxChannels === 0 || input.budget < 2 || input.days < 1) return { ...report, status: "skipped", reason: "no_budget" };

  const setup = await withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, "youtube");
    if (!runtime?.enabled || runtime.paused) return { skip: "paused_or_disabled" as const };
    const candidates = rowsOf<Candidate>(
      await tx.execute(sql`
        SELECT dc.id, dc.creator_id, dc.external_account_id, latest.checkpoint
        FROM discovered_creator dc
        LEFT JOIN LATERAL (
          SELECT r.started_at, r.status, r.checkpoint FROM provider_sync_run r
          WHERE r.provider_key = 'youtube' AND r."trigger" = ${YOUTUBE_BACKFILL_TRIGGER}
            AND r.checkpoint->>'channel_id' = dc.external_account_id
          ORDER BY r.started_at DESC LIMIT 1
        ) latest ON true
        WHERE dc.provider_key = 'youtube' AND dc.relevance_state = 'monitored'
          AND COALESCE((latest.checkpoint->>'done')::boolean, false) = false
          AND (latest.started_at IS NULL OR latest.status <> 'started'
            OR latest.started_at <= now() - (${YOUTUBE_BACKFILL_CLAIM_MINUTES}::int * interval '1 minute'))
          AND COALESCE((SELECT te.trust_state FROM creator_trust_event te WHERE te.creator_id = dc.creator_id
                ORDER BY te.created_at DESC LIMIT 1), '') <> 'excluded'
        ORDER BY (dc.discovery_provenance->>'operator_seed') = 'true' DESC NULLS LAST,
          latest.started_at ASC NULLS FIRST, dc.id
        LIMIT ${maxChannels}`),
    );
    if (candidates.length === 0) return { skip: "nothing_to_backfill" as const };
    return { candidates, index: await loadCardNameIndex(tx) };
  });
  if ("skip" in setup) return { ...report, status: "skipped", reason: setup.skip ?? null };

  for (const candidate of setup.candidates) {
    const state = stateFrom(candidate.checkpoint, candidate.external_account_id, now, input.days);
    const claim = await claimChannelRun(db, { candidate, reserve: maxPages * 2 + 1, budget: input.budget, state });
    if (!claim.claimed) {
      if (claim.reason === "budget_exhausted") return { ...report, status: "stopped", reason: "budget_exhausted" };
      continue;
    }
    report.channels += 1;
    const startRequests = input.requestCount();
    const used = () => input.requestCount() - startRequests;
    let received = 0;
    let stop: string | null = null;
    let errorClass: string | null = null;
    try {
      if (!state.uploads_playlist_id) {
        state.uploads_playlist_id = await input.provider.getUploadsPlaylistId(candidate.external_account_id);
        if (!state.uploads_playlist_id) {
          state.done = true;
          state.outcome = "channel_unavailable";
        }
      }
      const cutoff = Date.parse(state.cutoff);
      let pagesThisRun = 0;
      while (!state.done && pagesThisRun < maxPages && claim.reserve - used() >= 2) {
        if (!(await stillAllowed(db, candidate))) {
          stop = "operator_paused";
          break;
        }
        const page = await input.provider.getUploadsPage(state.uploads_playlist_id!, state.page_token);
        pagesThisRun += 1;
        state.pages += 1;
        report.pages += 1;
        const recent = page.items.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff);
        const reachedCutoff = page.items.some((item) => item.publishedAt && Date.parse(item.publishedAt) < cutoff);
        state.videos_seen += recent.length;
        if (recent.length > 0) {
          const details = await input.provider.getVideoDetails(recent.map((item) => item.videoId));
          for (const detail of details) {
            // Never attach another channel's video, and never one outside the window.
            if (detail.record.account.external_account_id !== candidate.external_account_id) continue;
            const published = Date.parse(detail.record.content.published_at);
            if (!Number.isFinite(published) || published < cutoff || published > now.getTime()) continue;
            report.videos += 1;
            const one = await ingestBackfilledVideo(db, { record: detail.record, description: detail.description, index: setup.index });
            if (one.stored) {
              received += 1;
              state.videos_stored += 1;
              report.stored += 1;
            }
            state.mentions += one.mentions;
            state.calls_created += one.callsCreated;
            report.mentions += one.mentions;
            report.callsCreated += one.callsCreated;
          }
        }
        state.page_token = page.nextPageToken;
        if (!page.nextPageToken || reachedCutoff) {
          state.done = true;
          state.outcome = "reached_cutoff";
        } else if (state.pages >= YOUTUBE_BACKFILL_MAX_PAGES_PER_CHANNEL) {
          state.done = true;
          state.outcome = "page_cap";
        }
        // Saved after every page, so a crash resumes at the next page.
        await saveRun(db, claim.runId, { requests: Math.max(used(), 0), received, state });
      }
    } catch (error) {
      if (error instanceof DiscoveryBudgetError) stop = "budget_exhausted";
      else {
        errorClass = error instanceof ProviderHttpError ? error.errorClass : "backfill_failed";
        stop = errorClass;
        if (errorClass === "not_found") {
          // Deleted channel or playlist: finished, not retried every hour.
          state.done = true;
          state.outcome = "not_found";
          errorClass = null;
        }
      }
    }
    if (state.done) report.finished += 1;
    await saveRun(db, claim.runId, {
      status: errorClass ? "failed" : "completed",
      errorClass,
      requests: used(),
      received,
      state: { ...state, outcome: state.done ? state.outcome : (stop ?? "in_progress") },
    });
    report.requests += used();
    if (stop === "budget_exhausted") return { ...report, status: "stopped", reason: "budget_exhausted" };
    // 403 is how the Data API reports an exhausted quota or a key problem: stop for this run.
    if (errorClass === "rate_limited" || errorClass === "auth") return { ...report, status: "stopped", reason: errorClass };
  }
  return report;
}

/**
 * The worker's YouTube backfill step: runs only with YOUTUBE_BACKFILL_DAYS
 * set, the YouTube provider live, credentialed, enabled and not paused.
 */
export async function runYoutubeBackfill(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; now?: Date } = {},
): Promise<YoutubeBackfillReport> {
  const env = input.env ?? process.env;
  const config = youtubeBackfillConfig(env);
  if (!config.enabled) return { ...emptyReport(), status: "skipped", reason: "disabled" };
  if (resolveProviderMode("youtube", env) !== "live" || !providerCredentialStatus("youtube", env).present) {
    return { ...emptyReport(), status: "skipped", reason: "not_live_or_credentialed" };
  }
  const runtime = await withPlatformContext(db, (tx) => getProviderRuntime(tx, "youtube"));
  if (!runtime?.enabled || runtime.paused || runtime.mode !== "live" || (runtime.retryAfterAt && runtime.retryAfterAt > new Date())) {
    return { ...emptyReport(), status: "skipped", reason: "paused_or_disabled" };
  }
  const budgeted = budgetedDiscoveryTransport(db, "youtube", env, input.transport);
  const provider = createLiveYoutubeProvider(env, budgeted.transport)!;
  return runYoutubeBackfillBatch(db, {
    provider,
    requestCount: budgeted.requestCount,
    budget: config.budget,
    days: config.days,
    now: input.now,
  });
}

export type YoutubeBackfillChannelRow = {
  channelId: string;
  creatorId: string | null;
  done: boolean;
  outcome: string | null;
  pages: number;
  videosStored: number;
  mentions: number;
  callsCreated: number;
  lastRunAt: Date | null;
};

/** Each channel's backfill progress (latest run), for the admin page. */
export async function listYoutubeBackfillProgress(db: Database, limit = 200): Promise<YoutubeBackfillChannelRow[]> {
  const rows = rowsOf<{ checkpoint: unknown; started_at: Date | string }>(
    await db.execute(sql`
      SELECT DISTINCT ON (checkpoint->>'channel_id') checkpoint, started_at FROM provider_sync_run
      WHERE provider_key = 'youtube' AND "trigger" = ${YOUTUBE_BACKFILL_TRIGGER}
      ORDER BY checkpoint->>'channel_id', started_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 500))}`),
  );
  return rows.map((row) => {
    const state = asRecord(row.checkpoint);
    return {
      channelId: String(state.channel_id ?? ""),
      creatorId: typeof state.creator_id === "string" ? state.creator_id : null,
      done: state.done === true,
      outcome: typeof state.outcome === "string" ? state.outcome : null,
      pages: Number(state.pages) || 0,
      videosStored: Number(state.videos_stored) || 0,
      mentions: Number(state.mentions) || 0,
      callsCreated: Number(state.calls_created) || 0,
      lastRunAt: row.started_at ? new Date(row.started_at) : null,
    };
  });
}
