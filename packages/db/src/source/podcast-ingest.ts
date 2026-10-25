/**
 * Podcast feeds as a creator source. An operator registers a podcast's RSS
 * feed; the worker reads it (providers/web-feed.ts, same bounds, robots.txt
 * and SSRF guard as influencer websites), stores each episode as source
 * content of the podcast's `rss` account with the episode's audio URL, and
 * turns card names in the show notes into mentions and creator calls.
 *
 * The audio itself is never fetched here. Episodes wait in the local
 * transcription queue (source/local-transcripts.ts) for the owner's own
 * computer to download the file the podcast publishes for download, run
 * Whisper on it and send back the timestamped text. Podcast enclosures are
 * published for exactly this kind of download; YouTube audio is never
 * downloaded anywhere.
 *
 * Registry: no new table. A registered podcast is a `source_account` row
 * (source_type `rss`, external_account_id = the feed URL) whose metadata
 * carries `podcast_feed` = { feed_url, state, registered_at, registered_by,
 * updated_at }. Each feed read is one `provider_sync_run` row (provider
 * `web_feed`, trigger `podcast_feed`, id `ppf_…`) and shares the web_feed
 * provider's live mode, pause control and lease.
 *
 * Retention: as for websites, show-notes text is never stored; only windows
 * that name a card are kept as bounded excerpts.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { isHostedRuntime } from "@isp/shared";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount, extractCreatorCallsFromContent } from "../creator/ingest.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { SOURCE_NORMALIZER_VERSION, resolveProviderMode } from "../providers/catalog.js";
import {
  ensureProviderRuntimeRows,
  getProviderRuntime,
  releaseProviderLease,
  tryAcquireProviderLease,
} from "../providers/runtime.js";
import type { HttpTransport } from "../providers/transport.js";
import { WebFeedClient, createWebFeedTransport, readWebFeed, type WebFeedPost, type WebFeedReadResult } from "../providers/web-feed.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceAccount, sourceIngest } from "../schema/source.js";
import { parseWebhookUrl, type DnsLookup } from "../webhooks/ssrf.js";
import { loadCardNameIndex, type CardNameIndex } from "./card-detect.js";
import { storeCardMentionSegments } from "./card-mentions.js";
import { ingestSourceContentRecord } from "./ingest.js";
import { stableSourceId, type SourceContentRecordInput } from "./identity.js";
import { canonicalPostUrl, planWebPostSegments } from "./web-feed-ingest.js";

export const PODCAST_NOTES_EXTRACTOR_VERSION = "source.podcast_notes.v1";
export const PODCAST_FEED_TRIGGER = "podcast_feed";
export const PODCAST_FEED_RUN_ID_PREFIX = "ppf_";
export const PODCAST_FEED_MAX_PER_RUN = 10;
export const PODCAST_FEED_INTERVAL_HOURS = 6;
/** Requests one feed read may make: robots.txt, the feed, a few redirects. */
export const PODCAST_FEED_MAX_REQUESTS = 5;
/** Newest episodes read from a feed per check; enough for a year of weekly or twice-weekly shows. */
export const PODCAST_FEED_MAX_EPISODES = 200;
/** Feeds that carry a long history are large; read up to 10 MB (the XML reader tolerates a cut). */
export const PODCAST_FEED_MAX_BODY_BYTES = 10_000_000;
export const DEFAULT_PODCAST_BACKFILL_DAYS = 365;
export const DEFAULT_PODCAST_FEED_REQUESTS_PER_DAY = 100;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonValue(value: unknown): Record<string, unknown> {
  return asRecord(typeof value === "string" ? JSON.parse(value) : value);
}

// ---------------------------------------------------------------------------
// Registry

export class PodcastFeedError extends Error {
  constructor(
    readonly code: "invalid_url" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "PodcastFeedError";
  }
}

export type PodcastFeedRegistration = {
  feed_url: string;
  state: "active" | "paused";
  registered_at: string;
  registered_by: string | null;
  updated_at: string;
};

/** The feed URL to register: public http(s), no fragment, no utm_* parameters. */
export function normalizePodcastFeedUrl(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let value = raw.trim();
  if (!value || value.length > 2_000) throw new PodcastFeedError("invalid_url", "A feed URL is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = parseWebhookUrl(value, env);
  } catch {
    throw new PodcastFeedError("invalid_url", "The feed URL must be a public http(s) address.");
  }
  const canonical = canonicalPostUrl(url.toString());
  if (!canonical) throw new PodcastFeedError("invalid_url", "The feed URL must be a public http(s) address.");
  return canonical;
}

export function podcastAccountId(feedUrl: string) {
  return stableSourceId("sac", ["rss", feedUrl]);
}

/**
 * Registers (or re-activates) a podcast feed as a creator source. Platform
 * context; records a break-glass audit row. Idempotent per feed URL.
 */
export async function registerPodcastFeed(
  db: Database,
  input: { feedUrl: string; displayName?: string | null; actorUserId: string; env?: NodeJS.ProcessEnv },
) {
  const feedUrl = normalizePodcastFeedUrl(input.feedUrl, input.env ?? process.env);
  const displayName = input.displayName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const id = podcastAccountId(feedUrl);
  const host = new URL(feedUrl).hostname;
  return withPlatformContext(db, async (tx) => {
    const now = new Date();
    await tx
      .insert(sourceAccount)
      .values({
        id,
        sourceType: "rss",
        externalAccountId: feedUrl,
        handle: host,
        displayName: displayName ?? host,
        canonicalUrl: feedUrl,
        metadata: { kind: "podcast" },
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing();
    const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, id)).limit(1);
    const previous = asRecord(account!.metadata.podcast_feed);
    const registration: PodcastFeedRegistration = {
      feed_url: feedUrl,
      state: "active",
      registered_at: asText(previous.registered_at) ?? now.toISOString(),
      registered_by: asText(previous.registered_by) ?? input.actorUserId,
      updated_at: now.toISOString(),
    };
    await tx
      .update(sourceAccount)
      .set({
        metadata: { ...account!.metadata, kind: "podcast", podcast_feed: registration },
        ...(displayName ? { displayName } : {}),
      })
      .where(eq(sourceAccount.id, id));
    const { creator } = await ensureCreatorForSourceAccount(tx, id);
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "source_account",
      targetId: id,
      metadata: { change: "podcast_feed.register", host },
    });
    return { sourceAccountId: id, creatorId: creator.id, feedUrl };
  });
}

/** Pauses or resumes a registered podcast. Paused feeds are not read and their episodes are not queued. */
export async function setPodcastFeedState(
  db: Database,
  input: { sourceAccountId: string; state: "active" | "paused"; actorUserId: string },
) {
  if (input.state !== "active" && input.state !== "paused") {
    throw new PodcastFeedError("invalid_url", "Unknown state.");
  }
  return withPlatformContext(db, async (tx) => {
    const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, input.sourceAccountId)).limit(1);
    const registration = asRecord(account?.metadata.podcast_feed);
    if (!account || account.sourceType !== "rss" || !asText(registration.feed_url)) {
      throw new PodcastFeedError("not_found", "Podcast is not registered.");
    }
    await tx
      .update(sourceAccount)
      .set({
        metadata: {
          ...account.metadata,
          podcast_feed: { ...registration, state: input.state, updated_at: new Date().toISOString() },
        },
      })
      .where(eq(sourceAccount.id, account.id));
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "source_account",
      targetId: account.id,
      metadata: { change: input.state === "paused" ? "podcast_feed.pause" : "podcast_feed.resume" },
    });
    return { sourceAccountId: account.id, state: input.state };
  });
}

export type PodcastFeedRow = {
  sourceAccountId: string;
  displayName: string | null;
  creatorId: string | null;
  feedUrl: string | null;
  state: string | null;
  episodes: number;
  transcribed: number;
  waiting: number;
  lastCheckAt: Date | null;
  lastStatus: string | null;
  lastOutcome: string | null;
  lastErrorClass: string | null;
};

/** Registered podcasts with episode and transcription counts, for the admin sources page. */
export async function listPodcastFeeds(db: Database, limit = 200): Promise<PodcastFeedRow[]> {
  const rows = rowsOf<{
    id: string;
    display_name: string | null;
    creator_id: string | null;
    registration: unknown;
    episodes: number | string;
    transcribed: number | string;
    started_at: Date | string | null;
    status: string | null;
    error_class: string | null;
    checkpoint: unknown;
  }>(
    await db.execute(sql`
      SELECT sa.id, sa.display_name, csa.creator_id, sa.metadata->'podcast_feed' AS registration,
        (SELECT count(*) FROM source_content sc WHERE sc.account_id = sa.id) AS episodes,
        (SELECT count(*) FROM source_content sc
          JOIN provider_sync_run r ON r.id = 'plt_' || sc.id AND r.status IN ('completed', 'skipped')
          WHERE sc.account_id = sa.id) AS transcribed,
        latest.started_at, latest.status, latest.error_class, latest.checkpoint
      FROM source_account sa
      LEFT JOIN creator_source_account csa ON csa.source_account_id = sa.id
      LEFT JOIN LATERAL (
        SELECT r.started_at, r.status, r.error_class, r.checkpoint FROM provider_sync_run r
        WHERE r.provider_key = 'web_feed' AND r."trigger" = ${PODCAST_FEED_TRIGGER}
          AND r.checkpoint->>'account_id' = sa.id
        ORDER BY r.started_at DESC LIMIT 1
      ) latest ON true
      WHERE sa.source_type = 'rss' AND sa.metadata->'podcast_feed' IS NOT NULL
      ORDER BY sa.display_name, sa.id
      LIMIT ${Math.max(1, Math.min(limit, 500))}`),
  );
  return rows.map((row) => {
    const registration = jsonValue(row.registration);
    const checkpoint = jsonValue(row.checkpoint);
    const episodes = Number(row.episodes);
    const transcribed = Number(row.transcribed);
    return {
      sourceAccountId: row.id,
      displayName: row.display_name,
      creatorId: row.creator_id,
      feedUrl: asText(registration.feed_url),
      state: asText(registration.state),
      episodes,
      transcribed,
      waiting: Math.max(0, episodes - transcribed),
      lastCheckAt: row.started_at ? new Date(row.started_at) : null,
      lastStatus: row.status,
      lastOutcome: asText(checkpoint.outcome),
      lastErrorClass: row.error_class,
    };
  });
}

// ---------------------------------------------------------------------------
// Episodes

export type PodcastFeed = { sourceAccountId: string; feedUrl: string; displayName: string | null };

/** Stable content id of an episode: the feed plus its guid, else its audio URL. */
export function podcastEpisodeExternalId(feedUrl: string, episode: Pick<WebFeedPost, "id" | "audio" | "link">) {
  const key = episode.id ?? episode.audio?.url ?? episode.link ?? "";
  return createHash("sha256").update(`${feedUrl}|${key}`).digest("hex").slice(0, 32);
}

export type PodcastEpisodeResult =
  | { status: "ingested"; contentId: string; mentions: number; callsCreated: number }
  | { status: "duplicate" | "no_audio"; contentId: string | null; mentions: 0; callsCreated: 0 };

/**
 * Stores one episode with its audio URL (for the local transcription queue)
 * and the card mentions in its show notes. An episode already stored is
 * skipped. One transaction per episode.
 */
export async function ingestPodcastEpisode(
  db: Database,
  input: { feed: PodcastFeed; episode: WebFeedPost; index: CardNameIndex; now?: Date },
): Promise<PodcastEpisodeResult> {
  const audio = input.episode.audio;
  if (!audio) return { status: "no_audio", contentId: null, mentions: 0, callsCreated: 0 };
  const externalId = podcastEpisodeExternalId(input.feed.feedUrl, input.episode);
  const recordId = `podcast:${externalId}`;
  return withPlatformContext(db, async (tx) => {
    const [existing] = await tx
      .select({ status: sourceIngest.processingStatus, contentId: sourceIngest.contentId })
      .from(sourceIngest)
      .where(and(eq(sourceIngest.sourceType, "rss"), eq(sourceIngest.sourceRecordId, recordId)))
      .limit(1);
    if (existing?.status === "processed") {
      return { status: "duplicate" as const, contentId: existing.contentId, mentions: 0 as const, callsCreated: 0 as const };
    }
    const now = input.now ?? new Date();
    const published =
      input.episode.publishedAt && input.episode.publishedAt.getTime() <= now.getTime() ? input.episode.publishedAt : now;
    const host = new URL(input.feed.feedUrl).hostname;
    const record: SourceContentRecordInput = {
      provider: "rss",
      provider_record_id: recordId,
      event_type: "source.content.ingested",
      account: {
        external_account_id: input.feed.feedUrl,
        handle: host,
        display_name: input.feed.displayName ?? host,
        canonical_url: input.feed.feedUrl,
        metadata: { kind: "podcast" },
      },
      content: {
        external_content_id: externalId,
        content_type: "post",
        published_at: published.toISOString(),
        title: input.episode.title?.slice(0, 300) ?? null,
        summary: null,
        canonical_url: canonicalPostUrl(input.episode.link) ?? audio.url,
        language: null,
        license_status: "reference_only",
        retention_policy: "bounded_excerpt",
        transcript_available: false,
        excerpt: null,
        metadata: {
          normalizer_version: SOURCE_NORMALIZER_VERSION,
          feed_provider: "podcast_feed",
          feed_url: input.feed.feedUrl.slice(0, 500),
          feed_guid: input.episode.id?.slice(0, 300) ?? null,
          published_at_source: input.episode.publishedAt ? "feed" : "observed",
          audio_url: audio.url,
          audio_type: audio.type,
          audio_bytes: audio.bytes,
          duration_seconds: input.episode.durationSeconds ?? null,
          text_source: input.episode.textSource,
        },
      },
    };
    const ingested = await ingestSourceContentRecord(tx, record);
    const contentId = ingested.contentId!;
    const planned = planWebPostSegments(contentId, input.episode.title, input.episode.text, input.index, {
      extractorVersion: PODCAST_NOTES_EXTRACTOR_VERSION,
      source: "podcast_notes",
    });
    const { mentions } = await storeCardMentionSegments(tx, {
      contentId,
      contentTitle: record.content.title ?? null,
      extractionVersion: PODCAST_NOTES_EXTRACTOR_VERSION,
      hintsKey: "card_detect",
      segments: planned,
    });
    let callsCreated = 0;
    if (mentions > 0) {
      const calls = await extractCreatorCallsFromContent(tx, contentId);
      callsCreated = calls.filter((row) => row.status === "processed").length;
    }
    return { status: "ingested" as const, contentId, mentions, callsCreated };
  });
}

// ---------------------------------------------------------------------------
// Sync

function boundedInteger(value: string | undefined, fallback: number, max: number, label: string) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${label} configuration.`);
  }
  return parsed;
}

/** PODCAST_FEED_REQUESTS_PER_DAY (default 100) and PODCAST_BACKFILL_DAYS (default 365, how far back episodes are kept). */
export function podcastFeedConfig(env: NodeJS.ProcessEnv) {
  return {
    budget: boundedInteger(env.PODCAST_FEED_REQUESTS_PER_DAY, DEFAULT_PODCAST_FEED_REQUESTS_PER_DAY, 10_000, "podcast feed request budget"),
    backfillDays: boundedInteger(env.PODCAST_BACKFILL_DAYS, DEFAULT_PODCAST_BACKFILL_DAYS, 3_650, "podcast backfill window"),
  };
}

export type PodcastFeedSyncReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  feeds: number;
  checked: number;
  notModified: number;
  skipped: number;
  failed: number;
  requests: number;
  episodes: number;
  newEpisodes: number;
  mentions: number;
  callsCreated: number;
};

function emptyReport(): PodcastFeedSyncReport {
  return {
    status: "completed",
    reason: null,
    feeds: 0,
    checked: 0,
    notModified: 0,
    skipped: 0,
    failed: 0,
    requests: 0,
    episodes: 0,
    newEpisodes: 0,
    mentions: 0,
    callsCreated: 0,
  };
}

async function claimFeedCheck(
  db: Database,
  input: { accountId: string; reserve: number; budget: number; intervalHours: number },
): Promise<{ claimed: true; runId: string } | { claimed: false; reason: "budget_exhausted" | "already_checked" }> {
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('podcast_feed.sync.v1'))`);
    const used = rowsOf<{ used: number | string | null }>(
      await tx.execute(sql`
        SELECT COALESCE(SUM(limit_count), 0) AS used FROM provider_sync_run
        WHERE provider_key = 'web_feed' AND "trigger" = ${PODCAST_FEED_TRIGGER}
          AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`),
    );
    if (Number(used[0]?.used ?? 0) + input.reserve > input.budget) return { claimed: false, reason: "budget_exhausted" };
    const recent = rowsOf<{ found: boolean }>(
      await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM provider_sync_run
          WHERE provider_key = 'web_feed' AND "trigger" = ${PODCAST_FEED_TRIGGER}
            AND checkpoint->>'account_id' = ${input.accountId}
            AND started_at > now() - (${input.intervalHours}::float8 * interval '1 hour')
        ) AS found`),
    );
    if (recent[0]?.found) return { claimed: false, reason: "already_checked" };
    const runId = `${PODCAST_FEED_RUN_ID_PREFIX}${createHash("sha256")
      .update(`${input.accountId}|${new Date().toISOString()}|${Math.random()}`)
      .digest("hex")
      .slice(0, 32)}`;
    await tx.insert(providerSyncRun).values({
      id: runId,
      providerKey: "web_feed",
      mode: "live",
      trigger: PODCAST_FEED_TRIGGER,
      status: "started",
      limitCount: input.reserve,
      checkpoint: { account_id: input.accountId },
    });
    return { claimed: true, runId };
  });
}

/**
 * Reads the registered, active podcast feeds that are due (not checked within
 * `intervalHours`), oldest check first, at most `maxFeeds`, within the daily
 * request `budget`. Episodes older than `backfillDays` are not stored.
 * Feeds of creators an operator excluded are skipped.
 */
export async function runPodcastFeedSyncBatch(
  db: Database,
  input: {
    budget: number;
    clientFor: (feed: PodcastFeed) => WebFeedClient;
    backfillDays?: number;
    maxFeeds?: number;
    intervalHours?: number;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<PodcastFeedSyncReport> {
  const report = emptyReport();
  const maxFeeds = Math.max(0, Math.min(input.maxFeeds ?? PODCAST_FEED_MAX_PER_RUN, PODCAST_FEED_MAX_PER_RUN));
  const intervalHours = Math.max(0, input.intervalHours ?? PODCAST_FEED_INTERVAL_HOURS);
  const backfillDays = input.backfillDays ?? DEFAULT_PODCAST_BACKFILL_DAYS;
  if (maxFeeds === 0 || input.budget < 1) return { ...report, status: "skipped", reason: "no_budget" };

  const setup = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, input.env ?? process.env);
    if ((await getProviderRuntime(tx, "web_feed"))?.paused) return { skip: "paused" as const };
    const candidates = rowsOf<{ id: string; display_name: string | null; registration: unknown; last_checkpoint: unknown }>(
      await tx.execute(sql`
        SELECT sa.id, sa.display_name, sa.metadata->'podcast_feed' AS registration, latest.checkpoint AS last_checkpoint
        FROM source_account sa
        LEFT JOIN LATERAL (
          SELECT r.started_at, r.checkpoint FROM provider_sync_run r
          WHERE r.provider_key = 'web_feed' AND r."trigger" = ${PODCAST_FEED_TRIGGER}
            AND r.checkpoint->>'account_id' = sa.id
          ORDER BY r.started_at DESC LIMIT 1
        ) latest ON true
        WHERE sa.source_type = 'rss' AND sa.status = 'active'
          AND sa.metadata->'podcast_feed'->>'state' = 'active'
          AND (latest.started_at IS NULL OR latest.started_at <= now() - (${intervalHours}::float8 * interval '1 hour'))
          AND NOT EXISTS (
            SELECT 1 FROM creator_source_account csa
            WHERE csa.source_account_id = sa.id
              AND (SELECT te.trust_state FROM creator_trust_event te
                   WHERE te.creator_id = csa.creator_id
                   ORDER BY te.created_at DESC LIMIT 1) = 'excluded')
        ORDER BY latest.started_at ASC NULLS FIRST, sa.id
        LIMIT ${maxFeeds}`),
    );
    if (candidates.length === 0) return { skip: "nothing_due" as const };
    return { candidates, index: await loadCardNameIndex(tx) };
  });
  if ("skip" in setup) return { ...report, status: "skipped", reason: setup.skip ?? null };

  const now = input.now ?? new Date();
  const oldest = now.getTime() - backfillDays * 86_400_000;
  for (const candidate of setup.candidates) {
    const registration = jsonValue(candidate.registration);
    const previous = jsonValue(candidate.last_checkpoint);
    const feedUrl = asText(registration.feed_url);
    if (!feedUrl) continue;
    const feed: PodcastFeed = { sourceAccountId: candidate.id, feedUrl, displayName: candidate.display_name };
    const client = input.clientFor(feed);
    const claim = await claimFeedCheck(db, {
      accountId: candidate.id,
      reserve: client.maxRequests,
      budget: input.budget,
      intervalHours,
    });
    if (!claim.claimed) {
      if (claim.reason === "budget_exhausted") return { ...report, status: "stopped", reason: "budget_exhausted" };
      continue;
    }
    report.feeds += 1;
    const sameFeed = feedUrl === asText(previous.feed_url);
    let result: WebFeedReadResult;
    try {
      result = await readWebFeed(client, {
        siteUrl: feedUrl,
        feedUrl,
        maxItems: PODCAST_FEED_MAX_EPISODES,
        etag: sameFeed ? asText(previous.etag) : null,
        lastModified: sameFeed ? asText(previous.last_modified) : null,
      });
    } catch {
      result = { status: "failed", reason: "network", feedUrl };
    }

    let episodes = 0;
    let newEpisodes = 0;
    let mentions = 0;
    let callsCreated = 0;
    let failures = 0;
    if (result.status === "ok") {
      for (const episode of result.posts) {
        // Undated episodes are kept: the feed lists newest first and they are within the newest PODCAST_FEED_MAX_EPISODES.
        if (episode.publishedAt && episode.publishedAt.getTime() < oldest) continue;
        if (!episode.audio) continue;
        episodes += 1;
        try {
          const one = await ingestPodcastEpisode(db, { feed, episode, index: setup.index, now });
          if (one.status === "ingested") {
            newEpisodes += 1;
            mentions += one.mentions;
            callsCreated += one.callsCreated;
          }
        } catch {
          failures += 1;
        }
      }
    }
    const status = result.status === "ok" || result.status === "not_modified" ? "completed" : result.status === "skipped" ? "skipped" : "failed";
    const validators =
      result.status === "ok" || result.status === "not_modified"
        ? { etag: result.etag, last_modified: result.lastModified }
        : { etag: asText(previous.etag), last_modified: asText(previous.last_modified) };
    await withPlatformContext(db, async (tx) => {
      await tx
        .update(providerSyncRun)
        .set({
          status,
          errorClass: result.status === "failed" || result.status === "skipped" ? result.reason : null,
          limitCount: client.requests,
          receivedCount: newEpisodes,
          quarantinedCount: failures,
          completedAt: new Date(),
          checkpoint: {
            account_id: candidate.id,
            outcome: result.status === "ok" ? "read" : result.status === "not_modified" ? "not_modified" : result.reason,
            feed_url: feedUrl,
            ...validators,
            truncated: result.status === "ok" ? result.truncated : false,
            requests: client.requests,
            episodes_seen: episodes,
            episodes_new: newEpisodes,
            episode_failures: failures,
            mentions,
            calls_created: callsCreated,
            extractor_version: PODCAST_NOTES_EXTRACTOR_VERSION,
          },
        })
        .where(eq(providerSyncRun.id, claim.runId));
    });
    report.requests += client.requests;
    report.episodes += episodes;
    report.newEpisodes += newEpisodes;
    report.mentions += mentions;
    report.callsCreated += callsCreated;
    if (result.status === "ok") report.checked += 1;
    else if (result.status === "not_modified") report.notModified += 1;
    else if (result.status === "skipped") report.skipped += 1;
    else report.failed += 1;
  }
  return report;
}

/**
 * The worker's podcast feed step. Shares the web_feed provider's controls:
 * runs only with PROVIDER_WEB_FEED_MODE=live, honors its pause / enable
 * switches and takes its lease, so it never overlaps the website feed run.
 */
export async function syncPodcastFeeds(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; lookup?: DnsLookup | null; now?: Date } = {},
): Promise<PodcastFeedSyncReport> {
  const env = input.env ?? process.env;
  const mode = resolveProviderMode("web_feed", env);
  if (mode !== "live") {
    return { ...emptyReport(), status: "skipped", reason: mode === "disabled" ? "disabled" : "fixture_not_supported" };
  }
  const runtime = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    return getProviderRuntime(tx, "web_feed");
  });
  if (runtime?.paused || (isHostedRuntime(env) && !runtime?.enabled)) {
    return { ...emptyReport(), status: "skipped", reason: "paused_or_disabled" };
  }
  const config = podcastFeedConfig(env);
  const leased = await withPlatformContext(db, (tx) => tryAcquireProviderLease(tx, "web_feed", 15 * 60_000));
  if (!leased) return { ...emptyReport(), status: "skipped", reason: "overlap" };
  try {
    const transport = input.transport ?? createWebFeedTransport({ maxBytes: PODCAST_FEED_MAX_BODY_BYTES });
    return await runPodcastFeedSyncBatch(db, {
      budget: config.budget,
      backfillDays: config.backfillDays,
      env,
      now: input.now,
      clientFor: () => new WebFeedClient({ transport, lookup: input.lookup, env, maxRequests: PODCAST_FEED_MAX_REQUESTS }),
    });
  } finally {
    await withPlatformContext(db, (tx) => releaseProviderLease(tx, "web_feed"));
  }
}
