/**
 * TikTok creators as a source. Two ways in, both on /admin/sources:
 *
 * - Follow a creator by profile link (tiktok.com/@handle). The owner's own
 *   computer lists the creator's newest videos during its nightly run
 *   (tools/local-whisper, with the free yt-dlp tool, captions and dates only,
 *   never the videos) and sends them to /internal/local-transcripts/tiktok.
 *   Each caption decides whether the video is kept: a catalog card name, or
 *   trading-card words such as "pokemon", "booster" or "psa". Other videos
 *   are counted and skipped, so the transcript service is never paid for a
 *   cooking video. No paid listing service is used.
 * - Paste individual video links, kept as they are.
 *
 * Each kept video is a `tiktok` video of the creator's account; the
 * transcript backfill (source/transcript-ingest.ts) then gets its transcript
 * from the paid transcript service (TRANSCRIPT_PROVIDER=supadata), which
 * fetches the video itself. Card names in a caption become mentions and
 * calls right away, like a YouTube title. Sentiment never downloads TikTok
 * media.
 *
 * Registry: no new table. A followed creator is a `source_account` row
 * (source_type `tiktok`) whose metadata carries `tiktok_follow` = { handle,
 * state, registered_at, registered_by, updated_at }. Each listing is one
 * `provider_sync_run` row (provider `tiktok`, trigger `tiktok_profile`, id
 * `ptk_…`): `started` when the computer claims the profile, then `completed`
 * with what was kept and skipped, or `failed`.
 *
 * Needs migration 0039_tiktok_source (the `tiktok` source platform); until it
 * runs, adding links fails with TikTokLinkError("migration_missing").
 *
 * A TikTok video id carries its upload time (the top 32 bits are Unix
 * seconds), so calls get the video's real date without fetching the page.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount, extractCreatorCallsFromContent } from "../creator/ingest.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { SOURCE_NORMALIZER_VERSION } from "../providers/catalog.js";
import { ensureProviderRuntimeRows, getProviderRuntime } from "../providers/runtime.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceAccount, sourceIngest } from "../schema/source.js";
import { detectCardMentions, loadCardNameIndex, type CardNameIndex } from "./card-detect.js";
import { storeCardMentionSegments } from "./card-mentions.js";
import { ingestSourceContentRecord } from "./ingest.js";
import { stableSourceId } from "./identity.js";
import { planWebPostSegments } from "./web-feed-ingest.js";

export const TIKTOK_MAX_LINKS_PER_ADD = 100;
export const TIKTOK_CAPTION_EXTRACTOR_VERSION = "source.tiktok_caption.v1";
export const TIKTOK_PROFILE_TRIGGER = "tiktok_profile";
export const TIKTOK_PROFILE_RUN_ID_PREFIX = "ptk_";
export const TIKTOK_PROFILE_MAX_PER_RUN = 10;
export const TIKTOK_PROFILE_INTERVAL_HOURS = 12;
/** Videos read from the top of a profile on a creator's first listing (the backfill) and on later ones. */
export const TIKTOK_FIRST_CHECK_MAX_VIDEOS = 300;
export const TIKTOK_LATER_CHECK_MAX_VIDEOS = 60;
export const TIKTOK_MAX_LISTED_VIDEOS = 1_000;
export const DEFAULT_TIKTOK_BACKFILL_DAYS = 365;
const MAX_SKIPPED_SAMPLES = 5;

const HANDLE = /^[a-z0-9._]{2,24}$/;
const VIDEO_ID = /^\d{15,25}$/;
/** TikTok launched internationally in 2017; earlier timestamps mean a malformed id. */
const EARLIEST_UPLOAD = Date.UTC(2016, 0, 1);

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

export class TikTokLinkError extends Error {
  constructor(
    readonly code: "no_links" | "too_many" | "migration_missing" | "invalid_profile" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "TikTokLinkError";
  }
}

function isMissingPlatform(error: unknown) {
  return /source_platform|foreign key/i.test(String((error as { cause?: unknown })?.cause ?? error));
}

export type TikTokVideoLink = { handle: string; videoId: string; url: string; publishedAt: Date };

/** Upload time encoded in a TikTok video id, or null when it is not plausible. */
export function tiktokVideoTime(videoId: string, now = new Date()): Date | null {
  if (!VIDEO_ID.test(videoId)) return null;
  const seconds = Number(BigInt(videoId) >> 32n);
  const time = seconds * 1000;
  return time >= EARLIEST_UPLOAD && time <= now.getTime() + 86_400_000 ? new Date(time) : null;
}

function tiktokUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!/^(www\.|m\.)?tiktok\.com$/i.test(url.hostname)) return null;
  return url;
}

function cleanHandle(raw: string): string | null {
  let handle: string;
  try {
    handle = decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
  return HANDLE.test(handle) ? handle : null;
}

/**
 * Reads a pasted TikTok video link: https://www.tiktok.com/@handle/video/<id>
 * (m. and www. hosts, query strings ignored). Short vm.tiktok.com links name
 * no creator or video and are refused rather than followed.
 */
export function parseTikTokVideoLink(raw: string, now = new Date()): TikTokVideoLink | null {
  const url = tiktokUrl(raw);
  if (!url) return null;
  const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
  if (!match) return null;
  const handle = cleanHandle(match[1]!);
  const videoId = match[2]!;
  if (!handle) return null;
  const publishedAt = tiktokVideoTime(videoId, now);
  if (!publishedAt) return null;
  return { handle, videoId, url: tiktokVideoUrl(handle, videoId), publishedAt };
}

/**
 * The creator handle in a profile link (tiktok.com/@handle), a video link, or
 * a bare "@handle" / "handle". Null when it is none of those.
 */
export function parseTikTokProfileLink(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 500) return null;
  const bare = value.match(/^@?([A-Za-z0-9._]{2,24})$/);
  if (bare) return cleanHandle(bare[1]!);
  const url = tiktokUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!url) return null;
  const match = url.pathname.match(/^\/@([^/]+)(?:\/(?:video\/\d+\/?)?)?$/);
  return match ? cleanHandle(match[1]!) : null;
}

export function tiktokVideoUrl(handle: string, videoId: string) {
  return `https://www.tiktok.com/@${handle}/video/${videoId}`;
}

export function tiktokAccountId(handle: string) {
  return stableSourceId("sac", ["tiktok", handle]);
}

// ---------------------------------------------------------------------------
// Deciding which videos to keep

/** Words that only appear in trading-card talk; matched anywhere, so hashtags like #pokemoncards count. */
const TCG_WORDS = /pok[eé]mon|tcg|yu-?gi-?oh|one ?piece ?(card|tcg)|optcg|dragon ?ball ?(super|card|fusion|z)|\bdbs ?(card|fw|fusion)|digimon ?card|lorcana|mtg|magic the gathering/i;
/** Collecting and grading words, as whole words. */
const CARD_WORDS =
  /\b(cards?|booster|boosters|packs?|etbs?|elite trainer|sealed|psa ?\d*|cgc|bgs|beckett|graded|grading|slabs?|slabbed|pulls?|pulled|binder|alt art|full art|illustration rare|special illustration|secret rare|holo|charizard|pikachu|umbreon|rayquaza|mewtwo|gengar|eevee|luffy|blue[- ]?eyes|goku)\b/i;

export type TikTokVideoDecision = { keep: boolean; reason: "card_name" | "card_words" | "no_card_signal" | "no_caption" };

/**
 * Whether a listed video is worth a transcript, from its caption alone: a
 * catalog card name, or trading-card words. Pure.
 */
export function decideTikTokVideo(caption: string, index: CardNameIndex | null): TikTokVideoDecision {
  const text = caption.trim();
  if (!text) return { keep: false, reason: "no_caption" };
  if (index && detectCardMentions(text, index).length > 0) return { keep: true, reason: "card_name" };
  // Hashtags are words too: "#pokemontcg #psa10" reads as "pokemontcg psa10".
  const plain = text.replace(/#/g, " ");
  if (TCG_WORDS.test(plain) || CARD_WORDS.test(plain)) return { keep: true, reason: "card_words" };
  return { keep: false, reason: "no_card_signal" };
}

// ---------------------------------------------------------------------------
// Storing a video

type StoreVideoInput = {
  handle: string;
  videoId: string;
  publishedAt: Date;
  displayName: string | null;
  caption: string | null;
  durationSeconds?: number | null;
  addedVia: "admin_links" | "profile_follow";
  index: CardNameIndex | null;
};

/**
 * Stores one TikTok video (idempotent per video) and, when it has a caption,
 * the card names in it as mentions and calls. Runs inside the caller's
 * platform-context transaction.
 */
async function storeTikTokVideo(
  tx: Database,
  input: StoreVideoInput,
): Promise<{ status: "added" | "duplicate"; mentions: number; callsCreated: number }> {
  const recordId = `tiktok:${input.videoId}`;
  const [existing] = await tx
    .select({ status: sourceIngest.processingStatus })
    .from(sourceIngest)
    .where(and(eq(sourceIngest.sourceType, "tiktok"), eq(sourceIngest.sourceRecordId, recordId)))
    .limit(1);
  if (existing?.status === "processed") return { status: "duplicate", mentions: 0, callsCreated: 0 };
  const caption = input.caption?.trim() ? input.caption.trim().slice(0, 300) : null;
  const ingested = await ingestSourceContentRecord(tx, {
    provider: "tiktok",
    provider_record_id: recordId,
    event_type: "source.content.ingested",
    account: {
      external_account_id: input.handle,
      handle: input.handle,
      display_name: input.displayName ?? `@${input.handle}`,
      canonical_url: `https://www.tiktok.com/@${input.handle}`,
      metadata: { kind: "tiktok" },
    },
    content: {
      external_content_id: input.videoId,
      content_type: "video",
      published_at: input.publishedAt.toISOString(),
      title: caption,
      summary: null,
      canonical_url: tiktokVideoUrl(input.handle, input.videoId),
      language: null,
      license_status: "reference_only",
      retention_policy: "bounded_excerpt",
      transcript_available: false,
      excerpt: null,
      metadata: {
        normalizer_version: SOURCE_NORMALIZER_VERSION,
        added_via: input.addedVia,
        published_at_source: input.addedVia === "admin_links" ? "video_id" : "listing",
        duration_seconds: input.durationSeconds ?? null,
      },
    },
  });
  let mentions = 0;
  let callsCreated = 0;
  if (caption && input.index && ingested.contentId) {
    const planned = planWebPostSegments(ingested.contentId, caption, "", input.index, {
      extractorVersion: TIKTOK_CAPTION_EXTRACTOR_VERSION,
      source: "tiktok_caption",
    });
    ({ mentions } = await storeCardMentionSegments(tx, {
      contentId: ingested.contentId,
      contentTitle: caption,
      extractionVersion: TIKTOK_CAPTION_EXTRACTOR_VERSION,
      hintsKey: "card_detect",
      segments: planned,
    }));
    if (mentions > 0) {
      const calls = await extractCreatorCallsFromContent(tx, ingested.contentId);
      callsCreated = calls.filter((row) => row.status === "processed").length;
    }
  }
  return { status: "added", mentions, callsCreated };
}

export type TikTokAddReport = {
  added: number;
  duplicates: number;
  rejected: string[];
  accounts: Array<{ handle: string; sourceAccountId: string; creatorId: string }>;
};

/**
 * Stores pasted TikTok video links as videos of their creators' accounts
 * (one creator per handle, created on first sight). Idempotent per video.
 * Platform context; audited. Lines that are not TikTok video links are
 * returned in `rejected`, untouched.
 */
export async function addTikTokVideoLinks(
  db: Database,
  input: { links: string; displayName?: string | null; actorUserId: string; now?: Date },
): Promise<TikTokAddReport> {
  const now = input.now ?? new Date();
  const lines = input.links
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new TikTokLinkError("no_links", "Paste at least one TikTok video link.");
  if (lines.length > TIKTOK_MAX_LINKS_PER_ADD) {
    throw new TikTokLinkError("too_many", `Paste at most ${TIKTOK_MAX_LINKS_PER_ADD} links at a time.`);
  }
  const report: TikTokAddReport = { added: 0, duplicates: 0, rejected: [], accounts: [] };
  const videos = new Map<string, TikTokVideoLink>();
  for (const line of lines) {
    const link = parseTikTokVideoLink(line, now);
    if (link) videos.set(link.videoId, link);
    else report.rejected.push(line.slice(0, 200));
  }
  if (videos.size === 0) return report;
  const displayName = input.displayName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;

  try {
    await withPlatformContext(db, async (tx) => {
      const handles = new Map<string, string>();
      for (const video of videos.values()) {
        const stored = await storeTikTokVideo(tx, {
          handle: video.handle,
          videoId: video.videoId,
          publishedAt: video.publishedAt,
          displayName,
          caption: null,
          addedVia: "admin_links",
          index: null,
        });
        if (stored.status === "duplicate") report.duplicates += 1;
        else report.added += 1;
        handles.set(video.handle, tiktokAccountId(video.handle));
      }
      for (const [handle, sourceAccountId] of handles) {
        const { creator } = await ensureCreatorForSourceAccount(tx, sourceAccountId);
        report.accounts.push({ handle, sourceAccountId, creatorId: creator.id });
        await insertBreakGlassAudit(tx, {
          actorUserId: input.actorUserId,
          action: "discovery.monitor",
          targetType: "source_account",
          targetId: sourceAccountId,
          metadata: { change: "tiktok.add_links", handle },
        });
      }
    });
  } catch (error) {
    if (isMissingPlatform(error)) {
      throw new TikTokLinkError("migration_missing", "TikTok needs database update 0039_tiktok_source first.");
    }
    throw error;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Following a creator

export type TikTokFollowRegistration = {
  handle: string;
  state: "active" | "paused";
  registered_at: string;
  registered_by: string | null;
  updated_at: string;
};

/**
 * Follows a TikTok creator by profile link (or @handle): the worker then
 * lists their videos and keeps the card ones. Re-following resumes a paused
 * creator. Platform context; audited. Idempotent per handle.
 */
export async function followTikTokCreator(
  db: Database,
  input: { profile: string; displayName?: string | null; actorUserId: string },
): Promise<{ handle: string; sourceAccountId: string; creatorId: string }> {
  const handle = parseTikTokProfileLink(input.profile);
  if (!handle) throw new TikTokLinkError("invalid_profile", "Paste a TikTok profile link, like https://www.tiktok.com/@creator.");
  const displayName = input.displayName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const id = tiktokAccountId(handle);
  try {
    return await withPlatformContext(db, async (tx) => {
      const now = new Date();
      await tx
        .insert(sourceAccount)
        .values({
          id,
          sourceType: "tiktok",
          externalAccountId: handle,
          handle,
          displayName: displayName ?? `@${handle}`,
          canonicalUrl: `https://www.tiktok.com/@${handle}`,
          metadata: { kind: "tiktok" },
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();
      const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, id)).limit(1);
      const previous = asRecord(account!.metadata.tiktok_follow);
      const registration: TikTokFollowRegistration = {
        handle,
        state: "active",
        registered_at: asText(previous.registered_at) ?? now.toISOString(),
        registered_by: asText(previous.registered_by) ?? input.actorUserId,
        updated_at: now.toISOString(),
      };
      await tx
        .update(sourceAccount)
        .set({
          metadata: { ...account!.metadata, kind: "tiktok", tiktok_follow: registration },
          ...(displayName ? { displayName } : {}),
        })
        .where(eq(sourceAccount.id, id));
      const { creator } = await ensureCreatorForSourceAccount(tx, id);
      await insertBreakGlassAudit(tx, {
        actorUserId: input.actorUserId,
        action: "discovery.monitor",
        targetType: "source_account",
        targetId: id,
        metadata: { change: "tiktok.follow", handle },
      });
      return { handle, sourceAccountId: id, creatorId: creator.id };
    });
  } catch (error) {
    if (isMissingPlatform(error)) {
      throw new TikTokLinkError("migration_missing", "TikTok needs database update 0039_tiktok_source first.");
    }
    throw error;
  }
}

/** Pauses or resumes a followed creator. Paused creators' profiles are not checked. */
export async function setTikTokFollowState(
  db: Database,
  input: { sourceAccountId: string; state: "active" | "paused"; actorUserId: string },
) {
  if (input.state !== "active" && input.state !== "paused") throw new TikTokLinkError("not_found", "Unknown state.");
  return withPlatformContext(db, async (tx) => {
    const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, input.sourceAccountId)).limit(1);
    const registration = asRecord(account?.metadata.tiktok_follow);
    if (!account || account.sourceType !== "tiktok" || !asText(registration.handle)) {
      throw new TikTokLinkError("not_found", "This TikTok creator is not followed.");
    }
    await tx
      .update(sourceAccount)
      .set({
        metadata: { ...account.metadata, tiktok_follow: { ...registration, state: input.state, updated_at: new Date().toISOString() } },
      })
      .where(eq(sourceAccount.id, account.id));
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "source_account",
      targetId: account.id,
      metadata: { change: input.state === "paused" ? "tiktok.pause" : "tiktok.resume" },
    });
    return { sourceAccountId: account.id, state: input.state };
  });
}

// ---------------------------------------------------------------------------
// Listing followed profiles on the owner's computer

function boundedInteger(value: string | undefined, fallback: number, max: number, label: string) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${label} configuration.`);
  }
  return parsed;
}

/** TIKTOK_BACKFILL_DAYS: how far back a creator's first listing reads (default 365). */
export function tiktokProfileConfig(env: NodeJS.ProcessEnv) {
  return {
    backfillDays: boundedInteger(env.TIKTOK_BACKFILL_DAYS, DEFAULT_TIKTOK_BACKFILL_DAYS, 3_650, "TikTok backfill window"),
  };
}

export type TikTokProfileJob = {
  source_account_id: string;
  handle: string;
  profile_url: string;
  /** Only videos uploaded after this time are wanted. */
  since: string;
  /** Most videos to read from the top of the profile. */
  max_videos: number;
  first_check: boolean;
};

function cleanWorker(value: string | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 60) || "unknown";
}

/**
 * Hands the owner's computer the followed, active creators whose profile is
 * due (not listed within TIKTOK_PROFILE_INTERVAL_HOURS), oldest check first.
 * Each claim is a `started` run; a claim older than the interval lapses, so a
 * computer that switched off does not hold it. Creators an operator excluded
 * and a paused `tiktok` provider are skipped.
 */
export async function claimTikTokProfileJobs(
  db: Database,
  input: { limit?: number; worker?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<TikTokProfileJob[]> {
  const env = input.env ?? process.env;
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? TIKTOK_PROFILE_MAX_PER_RUN), TIKTOK_PROFILE_MAX_PER_RUN));
  const now = input.now ?? new Date();
  const backfillFloor = new Date(now.getTime() - tiktokProfileConfig(env).backfillDays * 86_400_000);
  const worker = cleanWorker(input.worker);
  return withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    if ((await getProviderRuntime(tx, "tiktok"))?.paused) return [];
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tiktok_profile.claim.v1'))`);
    const due = rowsOf<{ id: string; registration: unknown; newest_at: string | null }>(
      await tx.execute(sql`
        SELECT sa.id, sa.metadata->'tiktok_follow' AS registration,
          (SELECT max(r.checkpoint->>'newest_at') FROM provider_sync_run r
            WHERE r.provider_key = 'tiktok' AND r."trigger" = ${TIKTOK_PROFILE_TRIGGER}
              AND r.status = 'completed' AND r.checkpoint->>'account_id' = sa.id) AS newest_at
        FROM source_account sa
        LEFT JOIN LATERAL (
          SELECT r.started_at FROM provider_sync_run r
          WHERE r.provider_key = 'tiktok' AND r."trigger" = ${TIKTOK_PROFILE_TRIGGER}
            AND r.checkpoint->>'account_id' = sa.id
          ORDER BY r.started_at DESC LIMIT 1
        ) latest ON true
        WHERE sa.source_type = 'tiktok' AND sa.status = 'active'
          AND sa.metadata->'tiktok_follow'->>'state' = 'active'
          AND (latest.started_at IS NULL OR latest.started_at <= now() - (${TIKTOK_PROFILE_INTERVAL_HOURS}::float8 * interval '1 hour'))
          AND NOT EXISTS (
            SELECT 1 FROM creator_source_account csa
            WHERE csa.source_account_id = sa.id
              AND (SELECT te.trust_state FROM creator_trust_event te
                   WHERE te.creator_id = csa.creator_id
                   ORDER BY te.created_at DESC LIMIT 1) = 'excluded')
        ORDER BY latest.started_at ASC NULLS FIRST, sa.id
        LIMIT ${limit}`),
    );
    const jobs: TikTokProfileJob[] = [];
    for (const row of due) {
      const handle = asText(jsonValue(row.registration).handle);
      if (!handle) continue;
      const previous = row.newest_at ? new Date(row.newest_at) : null;
      const firstCheck = !previous || Number.isNaN(previous.getTime());
      const since = firstCheck ? backfillFloor : new Date(Math.max(previous!.getTime(), backfillFloor.getTime()));
      const runId = `${TIKTOK_PROFILE_RUN_ID_PREFIX}${createHash("sha256")
        .update(`${row.id}|${now.toISOString()}|${Math.random()}`)
        .digest("hex")
        .slice(0, 32)}`;
      await tx.insert(providerSyncRun).values({
        id: runId,
        providerKey: "tiktok",
        mode: "live",
        trigger: TIKTOK_PROFILE_TRIGGER,
        status: "started",
        checkpoint: { account_id: row.id, handle, worker, since: since.toISOString(), first_check: firstCheck },
      });
      jobs.push({
        source_account_id: row.id,
        handle,
        profile_url: `https://www.tiktok.com/@${handle}`,
        since: since.toISOString(),
        max_videos: firstCheck ? TIKTOK_FIRST_CHECK_MAX_VIDEOS : TIKTOK_LATER_CHECK_MAX_VIDEOS,
        first_check: firstCheck,
      });
    }
    return jobs;
  });
}

export class TikTokListingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokListingValidationError";
  }
}

export type TikTokListedVideo = { videoId: string; caption: string; createdAt: Date | null; durationSeconds: number | null };

export type TikTokListingSubmission =
  | { status: "ok"; videos: TikTokListedVideo[]; tool: string | null }
  | { status: "error"; reason: string; tool: string | null };

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Validates what the helper sends back for one profile:
 * { status: "ok", videos: [{ id, caption, timestamp?, duration? }], tool? }
 * or { status: "error", reason, tool? }. Malformed videos are dropped, not fatal.
 */
export function parseTikTokListingSubmission(body: unknown): TikTokListingSubmission {
  const root = asRecord(body);
  const tool = asText(root.tool)?.replace(/[^A-Za-z0-9 ._:/-]/g, "").slice(0, 60) ?? null;
  if (root.status === "error") {
    const reason = (asText(root.reason) ?? "unknown").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
    return { status: "error", reason, tool };
  }
  if (root.status !== "ok" || !Array.isArray(root.videos)) {
    throw new TikTokListingValidationError("Send status ok with a videos list, or status error with a reason.");
  }
  if (root.videos.length > TIKTOK_MAX_LISTED_VIDEOS) throw new TikTokListingValidationError("Too many videos.");
  const videos: TikTokListedVideo[] = [];
  for (const entry of root.videos) {
    const item = asRecord(entry);
    const id = String(item.id ?? "");
    if (!VIDEO_ID.test(id)) continue;
    const caption = typeof item.caption === "string" ? item.caption : "";
    const timestamp = positiveNumber(item.timestamp);
    const duration = positiveNumber(item.duration);
    videos.push({
      videoId: id,
      caption: caption.replace(/\s+/g, " ").trim().slice(0, 2_200),
      createdAt: timestamp ? new Date(timestamp * 1000) : null,
      durationSeconds: duration ? Math.round(duration) : null,
    });
  }
  return { status: "ok", videos, tool };
}

export type TikTokListingReport =
  | { outcome: "not_claimed"; sourceAccountId: string }
  | {
      outcome: "listed" | "failed";
      sourceAccountId: string;
      listed: number;
      kept: number;
      skipped: number;
      duplicates: number;
      mentions: number;
      callsCreated: number;
    };

/**
 * Stores what the owner's computer found on a claimed profile: each video
 * newer than the claim's `since` is kept or skipped by its caption
 * (decideTikTokVideo), kept ones are stored with their caption's card
 * mentions and calls, and the claim's run is completed with the counts.
 */
export async function submitTikTokProfileListing(
  db: Database,
  input: { sourceAccountId: string; submission: TikTokListingSubmission; now?: Date },
): Promise<TikTokListingReport> {
  const now = input.now ?? new Date();
  const claim = await withPlatformContext(db, async (tx) => {
    const [row] = rowsOf<{ id: string; checkpoint: unknown; display_name: string | null }>(
      await tx.execute(sql`
        SELECT r.id, r.checkpoint, sa.display_name FROM provider_sync_run r
        JOIN source_account sa ON sa.id = r.checkpoint->>'account_id'
        WHERE r.provider_key = 'tiktok' AND r."trigger" = ${TIKTOK_PROFILE_TRIGGER}
          AND r.status = 'started' AND r.checkpoint->>'account_id' = ${input.sourceAccountId}
          AND r.started_at > now() - (${TIKTOK_PROFILE_INTERVAL_HOURS}::float8 * interval '1 hour')
        ORDER BY r.started_at DESC LIMIT 1`),
    );
    return row ? { runId: row.id, checkpoint: jsonValue(row.checkpoint), displayName: row.display_name } : null;
  });
  if (!claim) return { outcome: "not_claimed", sourceAccountId: input.sourceAccountId };
  const handle = asText(claim.checkpoint.handle)!;
  const since = new Date(asText(claim.checkpoint.since) ?? 0);
  const submission = input.submission;

  let kept = 0;
  let skipped = 0;
  let duplicates = 0;
  let mentions = 0;
  let callsCreated = 0;
  let failures = 0;
  let newest: Date | null = null;
  const skippedSamples: string[] = [];
  const reasons: Record<string, number> = {};
  const listed: Array<TikTokListedVideo & { publishedAt: Date }> = [];
  if (submission.status === "ok") {
    const seen = new Set<string>();
    for (const video of submission.videos) {
      if (seen.has(video.videoId)) continue;
      seen.add(video.videoId);
      const publishedAt = video.createdAt ?? tiktokVideoTime(video.videoId, now);
      if (!publishedAt || publishedAt.getTime() > now.getTime() + 86_400_000) continue;
      if (publishedAt.getTime() <= since.getTime()) continue;
      listed.push({ ...video, publishedAt });
      if (!newest || publishedAt > newest) newest = publishedAt;
    }
    const index = listed.length > 0 ? await withPlatformContext(db, (tx) => loadCardNameIndex(tx)) : null;
    for (const video of listed) {
      const decision = decideTikTokVideo(video.caption, index);
      reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
      if (!decision.keep) {
        skipped += 1;
        if (skippedSamples.length < MAX_SKIPPED_SAMPLES) skippedSamples.push(video.caption.slice(0, 100));
        continue;
      }
      try {
        const stored = await withPlatformContext(db, (tx) =>
          storeTikTokVideo(tx, {
            handle,
            videoId: video.videoId,
            publishedAt: video.publishedAt,
            displayName: claim.displayName,
            caption: video.caption,
            durationSeconds: video.durationSeconds,
            addedVia: "profile_follow",
            index,
          }),
        );
        if (stored.status === "duplicate") {
          duplicates += 1;
        } else {
          kept += 1;
          mentions += stored.mentions;
          callsCreated += stored.callsCreated;
        }
      } catch {
        failures += 1;
      }
    }
  }

  const failed = submission.status === "error";
  // A later listing starts from the newest video seen so far, never earlier.
  const newestAt = newest && newest > since ? newest : since;
  await withPlatformContext(db, async (tx) => {
    await tx
      .update(providerSyncRun)
      .set({
        status: failed ? "failed" : "completed",
        errorClass: submission.status === "error" ? submission.reason : null,
        receivedCount: kept,
        quarantinedCount: failures,
        completedAt: new Date(),
        checkpoint: {
          ...claim.checkpoint,
          outcome: failed ? "error" : "listed",
          tool: submission.tool,
          listed: listed.length,
          kept,
          skipped,
          duplicates,
          failures,
          decisions: reasons,
          skipped_samples: skippedSamples,
          newest_at: failed ? null : newestAt.toISOString(),
          mentions,
          calls_created: callsCreated,
          extractor_version: TIKTOK_CAPTION_EXTRACTOR_VERSION,
        },
      })
      .where(eq(providerSyncRun.id, claim.runId));
  });
  return {
    outcome: failed ? "failed" : "listed",
    sourceAccountId: input.sourceAccountId,
    listed: listed.length,
    kept,
    skipped,
    duplicates,
    mentions,
    callsCreated,
  };
}

// ---------------------------------------------------------------------------
// Admin listing

export type TikTokAccountRow = {
  sourceAccountId: string;
  handle: string;
  displayName: string | null;
  followState: string | null;
  videos: number;
  transcribed: number;
  calls: number;
  lastCheckAt: Date | null;
  lastStatus: string | null;
  lastErrorClass: string | null;
  lastKept: number | null;
  lastSkipped: number | null;
};

/** TikTok creators with their videos, transcripts checked, calls and last profile check, for the admin sources page. */
export async function listTikTokAccounts(db: Database, limit = 200): Promise<TikTokAccountRow[]> {
  const rows = rowsOf<{
    id: string;
    handle: string | null;
    display_name: string | null;
    follow_state: string | null;
    videos: number | string;
    transcribed: number | string;
    calls: number | string;
    started_at: Date | string | null;
    status: string | null;
    error_class: string | null;
    checkpoint: unknown;
  }>(
    await db.execute(sql`
      SELECT sa.id, sa.handle, sa.display_name, sa.metadata->'tiktok_follow'->>'state' AS follow_state,
        (SELECT count(*) FROM source_content sc WHERE sc.account_id = sa.id) AS videos,
        (SELECT count(*) FROM source_content sc
          JOIN provider_sync_run r ON r.id = 'ptx_' || sc.id AND r.status IN ('completed', 'skipped')
          WHERE sc.account_id = sa.id) AS transcribed,
        (SELECT count(*) FROM creator_call cc
          JOIN source_content sc ON sc.id = cc.content_id
          WHERE sc.account_id = sa.id) AS calls,
        latest.started_at, latest.status, latest.error_class, latest.checkpoint
      FROM source_account sa
      LEFT JOIN LATERAL (
        SELECT r.started_at, r.status, r.error_class, r.checkpoint FROM provider_sync_run r
        WHERE r.provider_key = 'tiktok' AND r."trigger" = ${TIKTOK_PROFILE_TRIGGER}
          AND r.checkpoint->>'account_id' = sa.id
        ORDER BY r.started_at DESC LIMIT 1
      ) latest ON true
      WHERE sa.source_type = 'tiktok'
      ORDER BY sa.handle
      LIMIT ${Math.max(1, Math.min(limit, 500))}`),
  );
  return rows.map((row) => {
    const checkpoint = jsonValue(row.checkpoint);
    const kept = Number(checkpoint.kept);
    const skipped = Number(checkpoint.skipped);
    return {
      sourceAccountId: row.id,
      handle: row.handle ?? "",
      displayName: row.display_name,
      followState: row.follow_state,
      videos: Number(row.videos),
      transcribed: Number(row.transcribed),
      calls: Number(row.calls),
      lastCheckAt: row.started_at ? new Date(row.started_at) : null,
      lastStatus: row.status,
      lastErrorClass: row.error_class,
      lastKept: Number.isFinite(kept) && row.checkpoint != null ? kept : null,
      lastSkipped: Number.isFinite(skipped) && row.checkpoint != null ? skipped : null,
    };
  });
}
