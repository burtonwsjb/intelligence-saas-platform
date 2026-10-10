/**
 * Influencer websites as a creator source. An operator registers a site; the
 * worker reads its RSS/Atom feed (providers/web-feed.ts), stores each post as
 * source content of the site's `web` account (the same account and creator a
 * web search finds for that domain), finds catalog card names in the post
 * text, keeps only the paragraphs that name a card as bounded segments, adds
 * one mention per card, resolves it and extracts creator calls, which then
 * count toward the site's accuracy like a YouTube video's.
 *
 * Registry: no new table. A registered site is a `source_account` row
 * (source_type `web`, external_account_id = domain) whose metadata carries
 * `web_feed` = { site_url, feed_url, state, registered_at, registered_by,
 * updated_at }. Each site check is one `provider_sync_run` row (provider
 * `web_feed`, trigger `web_feed`, id `pwf_…`) whose checkpoint carries the
 * account id, feed URL, ETag / Last-Modified and counts; `limit_count` holds
 * the requests the check used (reserved at its worst case first), which is
 * what the daily request budget sums.
 *
 * Retention: post text is never stored. Titles are content titles as for any
 * article; only windows of up to ~700 characters that name a card are kept,
 * as `paragraph` segments with an excerpt of at most 480 characters.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { isHostedRuntime } from "@isp/shared";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount, extractCreatorCallsFromContent } from "../creator/ingest.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { SOURCE_NORMALIZER_VERSION, resolveProviderMode } from "../providers/catalog.js";
import { isSkippedSiteDomain, siteDomain } from "../providers/live-google.js";
import {
  ensureProviderRuntimeRows,
  getProviderRuntime,
  recordProviderSyncResult,
  releaseProviderLease,
  tryAcquireProviderLease,
} from "../providers/runtime.js";
import type { HttpTransport } from "../providers/transport.js";
import {
  WebFeedClient,
  readWebFeed,
  textParagraphs,
  type WebFeedPost,
  type WebFeedReadResult,
} from "../providers/web-feed.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceAccount, sourceIngest } from "../schema/source.js";
import { parseWebhookUrl, type DnsLookup } from "../webhooks/ssrf.js";
import { detectCardMentions, loadCardNameIndex, type CardNameIndex } from "./card-detect.js";
import { boundedWindowExcerpt, cardMentionId, storeCardMentionSegments, type CardMentionSegment } from "./card-mentions.js";
import { ingestSourceContentRecord } from "./ingest.js";
import { normalizeMentionText, stableSourceId, type SourceContentRecordInput } from "./identity.js";

export const WEB_FEED_EXTRACTOR_VERSION = "source.web_feed.v1";
export const WEB_FEED_SYNC_TRIGGER = "web_feed";
export const WEB_FEED_RUN_ID_PREFIX = "pwf_";
export const WEB_FEED_MAX_SITES_PER_RUN = 10;
export const WEB_FEED_SITE_INTERVAL_HOURS = 6;
export const DEFAULT_WEB_FEED_REQUESTS_PER_DAY = 200;
const WINDOW_TARGET_CHARS = 700;
const MAX_CHUNK_CHARS = 1_000;
const MAX_MENTIONS_PER_POST = 40;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Registry

export class WebFeedSiteError extends Error {
  constructor(
    readonly code: "invalid_url" | "platform_site" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "WebFeedSiteError";
  }
}

export type WebFeedRegistration = {
  site_url: string;
  feed_url: string | null;
  state: "active" | "paused";
  registered_at: string;
  registered_by: string | null;
  updated_at: string;
};

function publicUrl(raw: string, env: NodeJS.ProcessEnv): URL {
  let value = raw.trim();
  if (!value || value.length > 2_000) throw new WebFeedSiteError("invalid_url", "A website URL is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    return parseWebhookUrl(value, env);
  } catch {
    throw new WebFeedSiteError("invalid_url", "The URL must be a public http(s) address.");
  }
}

/** The site URL to register and its domain. Platforms covered by their own providers and stores are refused. */
export function normalizeWebFeedSiteUrl(raw: string, env: NodeJS.ProcessEnv = process.env) {
  const url = publicUrl(raw, env);
  url.hash = "";
  url.search = "";
  const domain = siteDomain(url.hostname);
  if (!/^[a-z0-9.-]{3,253}$/.test(domain) || !domain.includes(".")) {
    throw new WebFeedSiteError("invalid_url", "The URL must name a website domain.");
  }
  if (isSkippedSiteDomain(domain)) {
    throw new WebFeedSiteError("platform_site", "This site is a platform or store, not a creator website.");
  }
  return { siteUrl: url.toString(), domain };
}

export function webFeedAccountId(domain: string) {
  return stableSourceId("sac", ["web", domain]);
}

/**
 * Registers (or re-activates) an influencer website as a creator source.
 * Platform context; records a break-glass audit row. Returns the account and
 * creator ids. Idempotent per domain.
 */
export async function registerWebFeedSite(
  db: Database,
  input: {
    siteUrl: string;
    feedUrl?: string | null;
    displayName?: string | null;
    actorUserId: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  const env = input.env ?? process.env;
  const site = normalizeWebFeedSiteUrl(input.siteUrl, env);
  const feedUrl = input.feedUrl?.trim() ? publicUrl(input.feedUrl, env).toString() : null;
  const displayName = input.displayName?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const id = webFeedAccountId(site.domain);
  return withPlatformContext(db, async (tx) => {
    const now = new Date();
    await tx
      .insert(sourceAccount)
      .values({
        id,
        sourceType: "web",
        externalAccountId: site.domain,
        handle: site.domain,
        displayName: displayName ?? site.domain,
        canonicalUrl: `https://${site.domain}`,
        metadata: { kind: "website" },
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing();
    const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, id)).limit(1);
    const previous = asRecord(account!.metadata.web_feed);
    const registration: WebFeedRegistration = {
      site_url: site.siteUrl,
      feed_url: feedUrl,
      state: "active",
      registered_at: asText(previous.registered_at) ?? now.toISOString(),
      registered_by: asText(previous.registered_by) ?? input.actorUserId,
      updated_at: now.toISOString(),
    };
    await tx
      .update(sourceAccount)
      .set({
        metadata: { ...account!.metadata, kind: account!.metadata.kind ?? "website", web_feed: registration },
        ...(displayName ? { displayName } : {}),
      })
      .where(eq(sourceAccount.id, id));
    const { creator } = await ensureCreatorForSourceAccount(tx, id);
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "source_account",
      targetId: id,
      metadata: { change: "web_feed.register", domain: site.domain, feed_url_given: feedUrl != null },
    });
    return { sourceAccountId: id, creatorId: creator.id, domain: site.domain, siteUrl: site.siteUrl, feedUrl };
  });
}

/** Pauses or resumes a registered site. Paused sites are not read. */
export async function setWebFeedSiteState(
  db: Database,
  input: { sourceAccountId: string; state: "active" | "paused"; actorUserId: string },
) {
  if (input.state !== "active" && input.state !== "paused") {
    throw new WebFeedSiteError("invalid_url", "Unknown state.");
  }
  return withPlatformContext(db, async (tx) => {
    const [account] = await tx.select().from(sourceAccount).where(eq(sourceAccount.id, input.sourceAccountId)).limit(1);
    const registration = asRecord(account?.metadata.web_feed);
    if (!account || account.sourceType !== "web" || !asText(registration.site_url)) {
      throw new WebFeedSiteError("not_found", "Website is not registered.");
    }
    await tx
      .update(sourceAccount)
      .set({
        metadata: {
          ...account.metadata,
          web_feed: { ...registration, state: input.state, updated_at: new Date().toISOString() },
        },
      })
      .where(eq(sourceAccount.id, account.id));
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "source_account",
      targetId: account.id,
      metadata: { change: input.state === "paused" ? "web_feed.pause" : "web_feed.resume" },
    });
    return { sourceAccountId: account.id, state: input.state };
  });
}

export type WebFeedSiteRow = {
  sourceAccountId: string;
  domain: string;
  displayName: string | null;
  creatorId: string | null;
  siteUrl: string | null;
  feedUrl: string | null;
  state: string | null;
  lastCheckAt: Date | null;
  lastStatus: string | null;
  lastErrorClass: string | null;
  lastOutcome: string | null;
  lastNewPosts: number | null;
};

/** Registered websites with their latest check, for the admin sources page. */
export async function listWebFeedSites(db: Database, limit = 200): Promise<WebFeedSiteRow[]> {
  const rows = rowsOf<{
    id: string;
    domain: string;
    display_name: string | null;
    creator_id: string | null;
    registration: unknown;
    started_at: Date | string | null;
    status: string | null;
    error_class: string | null;
    checkpoint: unknown;
  }>(
    await db.execute(sql`
      SELECT sa.id, sa.external_account_id AS domain, sa.display_name, csa.creator_id,
        sa.metadata->'web_feed' AS registration,
        latest.started_at, latest.status, latest.error_class, latest.checkpoint
      FROM source_account sa
      LEFT JOIN creator_source_account csa ON csa.source_account_id = sa.id
      LEFT JOIN LATERAL (
        SELECT r.started_at, r.status, r.error_class, r.checkpoint FROM provider_sync_run r
        WHERE r.provider_key = 'web_feed' AND r."trigger" = ${WEB_FEED_SYNC_TRIGGER}
          AND r.checkpoint->>'account_id' = sa.id
        ORDER BY r.started_at DESC LIMIT 1
      ) latest ON true
      WHERE sa.source_type = 'web' AND sa.metadata->'web_feed' IS NOT NULL
      ORDER BY sa.external_account_id
      LIMIT ${Math.max(1, Math.min(limit, 500))}`),
  );
  return rows.map((row) => {
    const registration = asRecord(typeof row.registration === "string" ? JSON.parse(row.registration) : row.registration);
    const checkpoint = asRecord(typeof row.checkpoint === "string" ? JSON.parse(row.checkpoint) : row.checkpoint);
    const posts = Number(checkpoint.posts_new);
    return {
      sourceAccountId: row.id,
      domain: row.domain,
      displayName: row.display_name,
      creatorId: row.creator_id,
      siteUrl: asText(registration.site_url),
      feedUrl: asText(registration.feed_url) ?? asText(checkpoint.feed_url),
      state: asText(registration.state),
      lastCheckAt: row.started_at ? new Date(row.started_at) : null,
      lastStatus: row.status,
      lastErrorClass: row.error_class,
      lastOutcome: asText(checkpoint.outcome),
      lastNewPosts: Number.isFinite(posts) ? posts : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Posts

/** The post URL used for identity: no fragment and no utm_* tracking parameters. */
export function canonicalPostUrl(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Stable content id of a post: the same hash of the canonical URL that web search results use. */
export function webPostExternalId(canonicalUrl: string) {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 32);
}

type TextWindow = { text: string; startRef: string; endRef: string };

function chunkParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_CHARS) return [paragraph];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < sentence.length; i += MAX_CHUNK_CHARS) {
      const piece = sentence.slice(i, i + MAX_CHUNK_CHARS);
      if (current && current.length + 1 + piece.length > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Body paragraphs grouped into ~700-character windows (`p=<first>`..`p=<last>`, 1-based), then the title. */
export function webPostWindows(title: string | null, text: string): TextWindow[] {
  const windows: TextWindow[] = [];
  let current: { parts: string[]; from: number; to: number } | null = null;
  const flush = () => {
    if (current) windows.push({ text: current.parts.join("\n"), startRef: `p=${current.from}`, endRef: `p=${current.to}` });
    current = null;
  };
  let index = 0;
  for (const paragraph of textParagraphs(text)) {
    for (const chunk of chunkParagraph(paragraph)) {
      index += 1;
      const length = current ? current.parts.reduce((sum, part) => sum + part.length + 1, 0) : 0;
      if (current && length + chunk.length > WINDOW_TARGET_CHARS) flush();
      if (!current) current = { parts: [], from: index, to: index };
      current.parts.push(chunk);
      current.to = index;
    }
  }
  flush();
  if (title?.trim()) windows.push({ text: title.trim(), startRef: "title", endRef: "title" });
  return windows;
}

/**
 * Windows of a post that name a card, as the segments and mentions to store.
 * Each card (name and collector number) is kept once per post, at its first
 * window; body text comes before the title. Pure.
 */
export function planWebPostSegments(
  contentId: string,
  title: string | null,
  text: string,
  index: CardNameIndex,
): CardMentionSegment[] {
  const planned: CardMentionSegment[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const window of webPostWindows(title, text)) {
    if (total >= MAX_MENTIONS_PER_POST) break;
    const detected = detectCardMentions(window.text, index).filter((mention) => {
      const key = `${mention.name.toLowerCase()}|${mention.collectorNumber ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const kept = detected.slice(0, MAX_MENTIONS_PER_POST - total);
    if (kept.length === 0) continue;
    total += kept.length;
    planned.push({
      id: stableSourceId("ssg", [contentId, "paragraph", window.startRef, window.endRef, WEB_FEED_EXTRACTOR_VERSION]),
      kind: "paragraph",
      startRef: window.startRef,
      endRef: window.endRef,
      excerpt: boundedWindowExcerpt(window.text, kept),
      metadata: { source: "web_feed", extractor_version: WEB_FEED_EXTRACTOR_VERSION },
      mentions: kept.map((mention) => {
        const rawEntityText = mention.collectorNumber ? `${mention.name} ${mention.collectorNumber}` : mention.name;
        const normalized = normalizeMentionText(rawEntityText);
        return {
          id: cardMentionId(contentId, normalized, WEB_FEED_EXTRACTOR_VERSION, window.startRef),
          rawEntityText,
          normalized,
          hints: {
            source: "web_feed",
            card_name: mention.name,
            matched_text: mention.matchedText,
            collector_number: mention.collectorNumber,
            set_key: mention.set?.key ?? null,
            set_name: mention.set?.name ?? null,
            game_key: mention.gameKey,
            paragraph: window.startRef,
          },
        };
      }),
    });
  }
  return planned;
}

export type WebFeedSite = {
  sourceAccountId: string;
  domain: string;
  displayName: string | null;
};

export type WebFeedPostResult =
  | { status: "ingested"; contentId: string; segments: number; mentions: number; callsCreated: number }
  | { status: "duplicate" | "no_link"; contentId: string | null; segments: 0; mentions: 0; callsCreated: 0 };

/**
 * Stores one feed post and the card mentions in it, then extracts the
 * content's creator calls. A post already ingested from the feed is skipped,
 * so re-reading a feed adds nothing. One transaction per post.
 */
export async function ingestWebFeedPost(
  db: Database,
  input: { site: WebFeedSite; post: WebFeedPost; feedUrl: string; index: CardNameIndex; now?: Date },
): Promise<WebFeedPostResult> {
  const link = canonicalPostUrl(input.post.link);
  if (!link) return { status: "no_link", contentId: null, segments: 0, mentions: 0, callsCreated: 0 };
  const externalId = webPostExternalId(link);
  const recordId = `feed:${externalId}`;
  return withPlatformContext(db, async (tx) => {
    const [existing] = await tx
      .select({ status: sourceIngest.processingStatus, contentId: sourceIngest.contentId })
      .from(sourceIngest)
      .where(and(eq(sourceIngest.sourceType, "web"), eq(sourceIngest.sourceRecordId, recordId)))
      .limit(1);
    if (existing?.status === "processed") {
      return { status: "duplicate" as const, contentId: existing.contentId, segments: 0 as const, mentions: 0 as const, callsCreated: 0 as const };
    }
    const now = input.now ?? new Date();
    const published = input.post.publishedAt && input.post.publishedAt.getTime() <= now.getTime() ? input.post.publishedAt : now;
    const record: SourceContentRecordInput = {
      provider: "web",
      provider_record_id: recordId,
      event_type: "source.content.ingested",
      account: {
        external_account_id: input.site.domain,
        handle: input.site.domain,
        display_name: input.site.displayName ?? input.site.domain,
        canonical_url: `https://${input.site.domain}`,
        metadata: { kind: "website" },
      },
      content: {
        external_content_id: externalId,
        content_type: "article",
        published_at: published.toISOString(),
        title: input.post.title?.slice(0, 300) ?? null,
        summary: null,
        canonical_url: link,
        language: null,
        license_status: "reference_only",
        retention_policy: "bounded_excerpt",
        transcript_available: false,
        excerpt: null,
        metadata: {
          normalizer_version: SOURCE_NORMALIZER_VERSION,
          feed_provider: "web_feed",
          feed_url: input.feedUrl.slice(0, 500),
          feed_guid: input.post.id?.slice(0, 300) ?? null,
          feed_author: input.post.author?.slice(0, 120) ?? null,
          published_at_source: input.post.publishedAt ? "feed" : "observed",
          text_source: input.post.textSource,
        },
      },
    };
    const ingested = await ingestSourceContentRecord(tx, record);
    const contentId = ingested.contentId!;
    const planned = planWebPostSegments(contentId, input.post.title, input.post.text, input.index);
    const { mentions } = await storeCardMentionSegments(tx, {
      contentId,
      contentTitle: record.content.title ?? null,
      extractionVersion: WEB_FEED_EXTRACTOR_VERSION,
      hintsKey: "card_detect",
      segments: planned,
    });
    let callsCreated = 0;
    if (mentions > 0) {
      const calls = await extractCreatorCallsFromContent(tx, contentId);
      callsCreated = calls.filter((row) => row.status === "processed").length;
    }
    return { status: "ingested" as const, contentId, segments: planned.length, mentions, callsCreated };
  });
}

// ---------------------------------------------------------------------------
// Sync

export function webFeedRequestBudget(env: NodeJS.ProcessEnv): number {
  const value = env.WEB_FEED_REQUESTS_PER_DAY;
  if (value == null || value.trim() === "") return DEFAULT_WEB_FEED_REQUESTS_PER_DAY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("Invalid web feed request budget configuration.");
  }
  return parsed;
}

export type WebFeedSyncReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  sites: number;
  checked: number;
  notModified: number;
  skipped: number;
  failed: number;
  requests: number;
  posts: number;
  newPosts: number;
  mentions: number;
  callsCreated: number;
};

function emptyReport(): WebFeedSyncReport {
  return {
    status: "completed",
    reason: null,
    sites: 0,
    checked: 0,
    notModified: 0,
    skipped: 0,
    failed: 0,
    requests: 0,
    posts: 0,
    newPosts: 0,
    mentions: 0,
    callsCreated: 0,
  };
}

type Candidate = {
  id: string;
  domain: string;
  display_name: string | null;
  registration: unknown;
  last_checkpoint: unknown;
};

function jsonValue(value: unknown): Record<string, unknown> {
  return asRecord(typeof value === "string" ? JSON.parse(value) : value);
}

/**
 * Reserves one site check in the daily budget, in a short committed
 * transaction before any request. An advisory lock serializes claims across
 * worker replicas; a site checked within the interval is not claimed again.
 */
async function claimSiteCheck(
  db: Database,
  input: { accountId: string; domain: string; reserve: number; budget: number; intervalHours: number },
): Promise<{ claimed: true; runId: string } | { claimed: false; reason: "budget_exhausted" | "already_checked" }> {
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('web_feed.sync.v1'))`);
    const used = rowsOf<{ used: number | string | null }>(
      await tx.execute(sql`
        SELECT COALESCE(SUM(limit_count), 0) AS used FROM provider_sync_run
        WHERE provider_key = 'web_feed' AND "trigger" = ${WEB_FEED_SYNC_TRIGGER}
          AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`),
    );
    if (Number(used[0]?.used ?? 0) + input.reserve > input.budget) return { claimed: false, reason: "budget_exhausted" };
    const recent = rowsOf<{ found: boolean }>(
      await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM provider_sync_run
          WHERE provider_key = 'web_feed' AND "trigger" = ${WEB_FEED_SYNC_TRIGGER}
            AND checkpoint->>'account_id' = ${input.accountId}
            AND started_at > now() - (${input.intervalHours}::float8 * interval '1 hour')
        ) AS found`),
    );
    if (recent[0]?.found) return { claimed: false, reason: "already_checked" };
    const runId = `${WEB_FEED_RUN_ID_PREFIX}${createHash("sha256")
      .update(`${input.accountId}|${new Date().toISOString()}|${Math.random()}`)
      .digest("hex")
      .slice(0, 32)}`;
    await tx.insert(providerSyncRun).values({
      id: runId,
      providerKey: "web_feed",
      mode: "live",
      trigger: WEB_FEED_SYNC_TRIGGER,
      status: "started",
      limitCount: input.reserve,
      checkpoint: { account_id: input.accountId, domain: input.domain },
    });
    return { claimed: true, runId };
  });
}

function checkStatus(result: WebFeedReadResult): "completed" | "skipped" | "failed" {
  if (result.status === "ok" || result.status === "not_modified") return "completed";
  return result.status === "skipped" ? "skipped" : "failed";
}

/**
 * Reads the registered, active websites that are due (not checked within
 * `intervalHours`), oldest check first, at most `maxSites`, within the daily
 * request `budget`. Sites of creators an operator excluded are skipped.
 */
export async function runWebFeedSyncBatch(
  db: Database,
  input: {
    budget: number;
    clientFor: (site: WebFeedSite) => WebFeedClient;
    maxSites?: number;
    intervalHours?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<WebFeedSyncReport> {
  const report = emptyReport();
  const maxSites = Math.max(0, Math.min(input.maxSites ?? WEB_FEED_MAX_SITES_PER_RUN, WEB_FEED_MAX_SITES_PER_RUN));
  const intervalHours = Math.max(0, input.intervalHours ?? WEB_FEED_SITE_INTERVAL_HOURS);
  if (maxSites === 0 || input.budget < 1) return { ...report, status: "skipped", reason: "no_budget" };

  const setup = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, input.env ?? process.env);
    if ((await getProviderRuntime(tx, "web_feed"))?.paused) return { skip: "paused" as const };
    const candidates = rowsOf<Candidate>(
      await tx.execute(sql`
        SELECT sa.id, sa.external_account_id AS domain, sa.display_name,
          sa.metadata->'web_feed' AS registration, latest.checkpoint AS last_checkpoint
        FROM source_account sa
        LEFT JOIN LATERAL (
          SELECT r.started_at, r.checkpoint FROM provider_sync_run r
          WHERE r.provider_key = 'web_feed' AND r."trigger" = ${WEB_FEED_SYNC_TRIGGER}
            AND r.checkpoint->>'account_id' = sa.id
          ORDER BY r.started_at DESC LIMIT 1
        ) latest ON true
        WHERE sa.source_type = 'web' AND sa.status = 'active'
          AND sa.metadata->'web_feed'->>'state' = 'active'
          AND (latest.started_at IS NULL OR latest.started_at <= now() - (${intervalHours}::float8 * interval '1 hour'))
          AND NOT EXISTS (
            SELECT 1 FROM discovered_creator dc
            WHERE dc.source_account_id = sa.id AND dc.relevance_state = 'excluded')
          AND NOT EXISTS (
            SELECT 1 FROM creator_source_account csa
            WHERE csa.source_account_id = sa.id
              AND (SELECT te.trust_state FROM creator_trust_event te
                   WHERE te.creator_id = csa.creator_id
                   ORDER BY te.created_at DESC LIMIT 1) = 'excluded')
        ORDER BY latest.started_at ASC NULLS FIRST, sa.id
        LIMIT ${maxSites}`),
    );
    if (candidates.length === 0) return { skip: "nothing_due" as const };
    return { candidates, index: await loadCardNameIndex(tx) };
  });
  if ("skip" in setup) return { ...report, status: "skipped", reason: setup.skip ?? null };

  for (const candidate of setup.candidates) {
    const registration = jsonValue(candidate.registration);
    const previous = jsonValue(candidate.last_checkpoint);
    const siteUrl = asText(registration.site_url);
    if (!siteUrl) continue;
    const site: WebFeedSite = {
      sourceAccountId: candidate.id,
      domain: candidate.domain,
      displayName: candidate.display_name,
    };
    const client = input.clientFor(site);
    const claim = await claimSiteCheck(db, {
      accountId: candidate.id,
      domain: candidate.domain,
      reserve: client.maxRequests,
      budget: input.budget,
      intervalHours,
    });
    if (!claim.claimed) {
      if (claim.reason === "budget_exhausted") return { ...report, status: "stopped", reason: "budget_exhausted" };
      continue;
    }
    report.sites += 1;
    const feedUrl = asText(registration.feed_url) ?? asText(previous.feed_url);
    const sameFeed = feedUrl != null && feedUrl === asText(previous.feed_url);
    let result: WebFeedReadResult;
    try {
      result = await readWebFeed(client, {
        siteUrl,
        feedUrl,
        etag: sameFeed ? asText(previous.etag) : null,
        lastModified: sameFeed ? asText(previous.last_modified) : null,
      });
    } catch {
      result = { status: "failed", reason: "network", feedUrl };
    }

    let posts = 0;
    let newPosts = 0;
    let mentions = 0;
    let callsCreated = 0;
    let postFailures = 0;
    if (result.status === "ok") {
      for (const post of result.posts) {
        posts += 1;
        try {
          const one = await ingestWebFeedPost(db, { site, post, feedUrl: result.feedUrl, index: setup.index });
          if (one.status === "ingested") {
            newPosts += 1;
            mentions += one.mentions;
            callsCreated += one.callsCreated;
          }
        } catch {
          postFailures += 1;
        }
      }
    }
    const status = checkStatus(result);
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
          receivedCount: newPosts,
          quarantinedCount: postFailures,
          completedAt: new Date(),
          checkpoint: {
            account_id: candidate.id,
            domain: candidate.domain,
            outcome: result.status === "ok" ? "read" : result.status === "not_modified" ? "not_modified" : result.reason,
            feed_url: result.feedUrl ?? feedUrl,
            ...validators,
            format: result.status === "ok" ? result.format : (asText(previous.format) ?? null),
            truncated: result.status === "ok" ? result.truncated : false,
            requests: client.requests,
            posts_seen: posts,
            posts_new: newPosts,
            post_failures: postFailures,
            mentions,
            calls_created: callsCreated,
            extractor_version: WEB_FEED_EXTRACTOR_VERSION,
          },
        })
        .where(eq(providerSyncRun.id, claim.runId));
    });
    report.requests += client.requests;
    report.posts += posts;
    report.newPosts += newPosts;
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
 * The worker's website feed step: runs only with PROVIDER_WEB_FEED_MODE=live,
 * honors the provider's pause / enable controls, takes the provider lease so
 * two replicas never read sites at once, and records the result on the
 * provider runtime row.
 */
export async function syncWebFeeds(
  db: Database,
  input: {
    env?: NodeJS.ProcessEnv;
    transport?: HttpTransport;
    lookup?: DnsLookup | null;
    maxSites?: number;
    intervalHours?: number;
  } = {},
): Promise<WebFeedSyncReport> {
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
  const leased = await withPlatformContext(db, (tx) => tryAcquireProviderLease(tx, "web_feed", 15 * 60_000));
  if (!leased) return { ...emptyReport(), status: "skipped", reason: "overlap" };
  try {
    const report = await runWebFeedSyncBatch(db, {
      budget: webFeedRequestBudget(env),
      maxSites: input.maxSites,
      intervalHours: input.intervalHours,
      env,
      clientFor: () => new WebFeedClient({ transport: input.transport, lookup: input.lookup, env }),
    });
    if (report.status !== "skipped") {
      const ok = report.failed === 0 || report.checked + report.notModified > 0;
      await withPlatformContext(db, (tx) =>
        recordProviderSyncResult(tx, {
          providerKey: "web_feed",
          ok,
          errorClass: ok ? null : "feed_failures",
          received: report.newPosts,
          healthStatus: ok ? "healthy" : "degraded",
        }),
      );
    }
    return report;
  } finally {
    await withPlatformContext(db, (tx) => releaseProviderLease(tx, "web_feed"));
  }
}
