/**
 * Twelve-month backfill for registered influencer websites. A feed usually
 * holds only the newest 10–20 posts, so this walks the site's sitemap
 * (robots.txt `Sitemap:` lines, else /sitemap.xml and /sitemap_index.xml,
 * following sitemap indexes) for post URLs modified within the window, then
 * reads those article pages one by one through the same bounded, robots.txt
 * honoring WebFeedClient as the feed reader. A post counts only when its page
 * states a publication time inside the window (never the modified time).
 *
 * Retention is the web feed's: only the title and ≤480-character excerpts
 * around card names are kept; page text is never stored.
 *
 * Bounds: WEB_BACKFILL_MAX_REQUESTS_PER_SITE_RUN requests per site per run,
 * WEB_FEED_BACKFILL_REQUESTS_PER_SITE_PER_DAY per site per Pacific day, and
 * the shared WEB_FEED_REQUESTS_PER_DAY budget across feed checks and backfill
 * runs. At most WEB_BACKFILL_MAX_SITEMAPS sitemaps and WEB_BACKFILL_MAX_URLS
 * post URLs per site.
 *
 * State: each site run is one provider_sync_run row (provider `web_feed`,
 * trigger `web_backfill`, id `pwb_…`); the newest row's checkpoint carries
 * the site's queue (sitemaps still to read, post URLs still to fetch) and
 * totals, and older rows drop their queues when a new run starts.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isHostedRuntime } from "@isp/shared";
import type { Database } from "../client.js";
import { resolveProviderMode } from "../providers/catalog.js";
import { ensureProviderRuntimeRows, getProviderRuntime } from "../providers/runtime.js";
import type { HttpTransport } from "../providers/transport.js";
import { WebFeedClient, articleMetadata, articleText, parseSitemap } from "../providers/web-feed.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceIngest } from "../schema/source.js";
import type { DnsLookup } from "../webhooks/ssrf.js";
import { loadCardNameIndex } from "./card-detect.js";
import {
  WEB_BACKFILL_TRIGGER,
  WEB_FEED_SYNC_TRIGGER,
  canonicalPostUrl,
  ingestWebFeedPost,
  webFeedRequestBudget,
  webPostExternalId,
  type WebFeedSite,
} from "./web-feed-ingest.js";

export { WEB_BACKFILL_TRIGGER } from "./web-feed-ingest.js";
export const WEB_BACKFILL_RUN_PREFIX = "pwb_";
export const WEB_BACKFILL_MAX_SITES_PER_RUN = 3;
export const WEB_BACKFILL_MAX_REQUESTS_PER_SITE_RUN = 10;
export const DEFAULT_WEB_BACKFILL_REQUESTS_PER_SITE_PER_DAY = 30;
export const WEB_BACKFILL_MAX_SITEMAPS = 25;
export const WEB_BACKFILL_MAX_URLS = 300;
export const WEB_BACKFILL_MAX_DAYS = 400;
export const WEB_BACKFILL_INTERVAL_MINUTES = 50;

/** Paths that are listings, not posts. */
const NON_POST_PATH =
  /\/(?:tag|tags|category|categories|author|authors|page|search|cart|checkout|account|collections|products|product|shop|store|login|wp-admin|wp-json|feed|comments?)(?:\/|$)/i;

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
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`Invalid ${key} configuration.`);
  return parsed;
}

/** WEB_FEED_BACKFILL_DAYS (0 or unset: off; recommended 365) and the per-site daily cap. */
export function webBackfillConfig(env: NodeJS.ProcessEnv = process.env) {
  const days = intEnv(env, "WEB_FEED_BACKFILL_DAYS", 0, WEB_BACKFILL_MAX_DAYS);
  const perSiteDay = intEnv(
    env,
    "WEB_FEED_BACKFILL_REQUESTS_PER_SITE_PER_DAY",
    DEFAULT_WEB_BACKFILL_REQUESTS_PER_SITE_PER_DAY,
    1_000,
  );
  return { enabled: days > 0 && perSiteDay > 0, days, perSiteDay };
}

/**
 * Whether a sitemap URL is a post of this site: same host (or a subdomain of
 * the site's domain), under the registered path when the site URL has one,
 * not the home page and not a listing page.
 */
export function isSitePostUrl(url: string, site: { domain: string; siteUrl: string }): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(site.siteUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith(`.${site.domain}`)) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
  if (!path || path === prefix) return false;
  if (NON_POST_PATH.test(parsed.pathname)) return false;
  return !/\.(?:xml|gz|jpg|jpeg|png|gif|webp|pdf|mp3|mp4|zip)$/i.test(parsed.pathname);
}

function sameSiteHost(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export type WebBackfillState = {
  account_id: string;
  cutoff: string;
  phase: "discover" | "sitemaps" | "posts" | "done";
  sitemap_queue: string[];
  sitemaps_seen: string[];
  urls: string[];
  urls_total: number;
  posts_ingested: number;
  posts_old: number;
  posts_undated: number;
  posts_duplicate: number;
  posts_blocked: number;
  mentions: number;
  calls_created: number;
  outcome: string | null;
};

export function initialWebBackfillState(accountId: string, now: Date, days: number): WebBackfillState {
  return {
    account_id: accountId,
    cutoff: new Date(now.getTime() - days * 86_400_000).toISOString(),
    phase: "discover",
    sitemap_queue: [],
    sitemaps_seen: [],
    urls: [],
    urls_total: 0,
    posts_ingested: 0,
    posts_old: 0,
    posts_undated: 0,
    posts_duplicate: 0,
    posts_blocked: 0,
    mentions: 0,
    calls_created: 0,
    outcome: null,
  };
}

function stateFrom(value: unknown, accountId: string, now: Date, days: number): WebBackfillState {
  const raw = asRecord(value);
  const base = initialWebBackfillState(accountId, now, days);
  if (raw.account_id !== accountId || typeof raw.cutoff !== "string") return base;
  const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const num = (key: string) => (Number.isFinite(Number(raw[key])) ? Number(raw[key]) : 0);
  const phase = ["discover", "sitemaps", "posts", "done"].includes(String(raw.phase)) ? (raw.phase as WebBackfillState["phase"]) : "discover";
  return {
    ...base,
    cutoff: raw.cutoff,
    phase,
    sitemap_queue: list("sitemap_queue"),
    sitemaps_seen: list("sitemaps_seen"),
    urls: list("urls"),
    urls_total: num("urls_total"),
    posts_ingested: num("posts_ingested"),
    posts_old: num("posts_old"),
    posts_undated: num("posts_undated"),
    posts_duplicate: num("posts_duplicate"),
    posts_blocked: num("posts_blocked"),
    mentions: num("mentions"),
    calls_created: num("calls_created"),
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
  };
}

export type WebBackfillReport = {
  status: "completed" | "skipped" | "stopped";
  reason: string | null;
  sites: number;
  finished: number;
  requests: number;
  sitemaps: number;
  pages: number;
  posts: number;
  mentions: number;
  callsCreated: number;
};

function emptyReport(): WebBackfillReport {
  return { status: "completed", reason: null, sites: 0, finished: 0, requests: 0, sitemaps: 0, pages: 0, posts: 0, mentions: 0, callsCreated: 0 };
}

type Candidate = { id: string; domain: string; display_name: string | null; registration: unknown; previous_id: string | null; checkpoint: unknown };

async function claimSiteBackfill(
  db: Database,
  input: { candidate: Candidate; reserve: number; budget: number; perSiteDay: number; state: WebBackfillState },
): Promise<{ claimed: true; runId: string } | { claimed: false; reason: "budget_exhausted" | "site_day_cap" | "already_running" }> {
  return withPlatformContext(db, async (tx) => {
    // The web feed's lock: claims of both kinds see the same daily total.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('web_feed.sync.v1'))`);
    const usage = rowsOf<{ used: number | string | null; site: number | string | null; recent: boolean }>(
      await tx.execute(sql`
        SELECT
          COALESCE(SUM(limit_count), 0) AS used,
          COALESCE(SUM(limit_count) FILTER (WHERE "trigger" = ${WEB_BACKFILL_TRIGGER}
            AND checkpoint->>'account_id' = ${input.candidate.id}), 0) AS site,
          COALESCE(bool_or("trigger" = ${WEB_BACKFILL_TRIGGER} AND checkpoint->>'account_id' = ${input.candidate.id}
            AND started_at > now() - (${WEB_BACKFILL_INTERVAL_MINUTES}::int * interval '1 minute')), false) AS recent
        FROM provider_sync_run
        WHERE provider_key = 'web_feed' AND "trigger" IN (${WEB_FEED_SYNC_TRIGGER}, ${WEB_BACKFILL_TRIGGER})
          AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`),
    );
    const row = usage[0];
    if (row?.recent === true) return { claimed: false, reason: "already_running" };
    if (Number(row?.used ?? 0) + input.reserve > input.budget) return { claimed: false, reason: "budget_exhausted" };
    if (Number(row?.site ?? 0) + input.reserve > input.perSiteDay) return { claimed: false, reason: "site_day_cap" };
    if (input.candidate.previous_id) {
      // The queue moves to the new run; the old row keeps only its totals.
      await tx.execute(sql`
        UPDATE provider_sync_run SET checkpoint = checkpoint - 'urls' - 'sitemap_queue' - 'sitemaps_seen'
        WHERE id = ${input.candidate.previous_id}`);
    }
    const runId = `${WEB_BACKFILL_RUN_PREFIX}${createHash("sha256")
      .update(`${input.candidate.id}|${new Date().toISOString()}|${Math.random()}`)
      .digest("hex")
      .slice(0, 32)}`;
    await tx.insert(providerSyncRun).values({
      id: runId,
      providerKey: "web_feed",
      mode: "live",
      trigger: WEB_BACKFILL_TRIGGER,
      status: "started",
      limitCount: input.reserve,
      checkpoint: { ...input.state, domain: input.candidate.domain },
    });
    return { claimed: true, runId };
  });
}

async function alreadyIngested(db: Database, urls: string[]): Promise<Set<string>> {
  const byId = new Map<string, string>();
  for (const url of urls) {
    const canonical = canonicalPostUrl(url);
    if (canonical) byId.set(`feed:${webPostExternalId(canonical)}`, url);
  }
  if (byId.size === 0) return new Set();
  const rows = await withPlatformContext(db, (tx) =>
    tx
      .select({ id: sourceIngest.sourceRecordId })
      .from(sourceIngest)
      .where(
        and(
          eq(sourceIngest.sourceType, "web"),
          eq(sourceIngest.processingStatus, "processed"),
          inArray(sourceIngest.sourceRecordId, [...byId.keys()]),
        ),
      ),
  );
  return new Set(rows.map((row) => byId.get(row.id)!).filter(Boolean));
}

/**
 * One run over one site: discover sitemaps, read sitemaps into the URL queue,
 * then fetch queued posts, until the run's request cap. Returns the updated
 * state and counts. Pure HTTP through `client`; database writes are the
 * posts' own transactions.
 */
async function advanceSite(
  db: Database,
  input: {
    client: WebFeedClient;
    site: WebFeedSite & { siteUrl: string };
    state: WebBackfillState;
    index: Awaited<ReturnType<typeof loadCardNameIndex>>;
    now: Date;
  },
) {
  const { client, site, state, now } = input;
  const counts = { sitemaps: 0, pages: 0, posts: 0, mentions: 0, callsCreated: 0 };
  const cutoff = Date.parse(state.cutoff);
  const origin = new URL(site.siteUrl).origin;
  let stop: string | null = null;

  if (state.phase === "discover") {
    const listed = await client.sitemapsFor(origin);
    if (listed === "request_cap") return { state, counts, stop: "request_cap" };
    const fromRobots = listed === "unreachable" ? [] : listed.filter((url) => sameSiteHost(url, site.domain));
    state.sitemap_queue = (fromRobots.length > 0 ? fromRobots : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]).slice(
      0,
      WEB_BACKFILL_MAX_SITEMAPS,
    );
    state.phase = "sitemaps";
  }

  while (state.phase === "sitemaps" && !stop) {
    const next = state.sitemap_queue.shift();
    if (!next) {
      state.phase = "posts";
      break;
    }
    if (client.remaining === 0) {
      state.sitemap_queue.unshift(next);
      stop = "request_cap";
      break;
    }
    if (state.sitemaps_seen.includes(next)) continue;
    state.sitemaps_seen.push(next);
    const got = await client.get(next, { accept: "application/xml, text/xml;q=0.9, */*;q=0.1" });
    counts.sitemaps += 1;
    if (got.kind === "blocked") {
      if (got.reason === "request_cap") {
        state.sitemaps_seen.pop();
        state.sitemap_queue.unshift(next);
        stop = "request_cap";
      }
      continue;
    }
    if (got.response.status === 429) {
      state.sitemaps_seen.pop();
      state.sitemap_queue.unshift(next);
      stop = "rate_limited";
      break;
    }
    if (got.response.status < 200 || got.response.status >= 300) continue;
    const parsed = parseSitemap(got.response.bodyText, got.url);
    if (!parsed) continue;
    const recent = parsed.entries.filter((entry) => !entry.lastmod || entry.lastmod.getTime() >= cutoff);
    if (parsed.kind === "index") {
      for (const entry of recent) {
        if (state.sitemaps_seen.length + state.sitemap_queue.length >= WEB_BACKFILL_MAX_SITEMAPS) break;
        if (!sameSiteHost(entry.loc, site.domain) || /\.gz$/i.test(new URL(entry.loc).pathname)) continue;
        if (!state.sitemaps_seen.includes(entry.loc) && !state.sitemap_queue.includes(entry.loc)) state.sitemap_queue.push(entry.loc);
      }
    } else {
      const posts = recent
        .filter((entry) => isSitePostUrl(entry.loc, { domain: site.domain, siteUrl: site.siteUrl }))
        .sort((a, b) => (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0));
      for (const entry of posts) {
        if (state.urls_total >= WEB_BACKFILL_MAX_URLS) break;
        if (state.urls.includes(entry.loc)) continue;
        state.urls.push(entry.loc);
        state.urls_total += 1;
      }
    }
  }

  if (state.phase === "posts" && !stop) {
    const known = await alreadyIngested(db, state.urls);
    while (state.urls.length > 0) {
      const url = state.urls[0]!;
      if (known.has(url)) {
        state.urls.shift();
        state.posts_duplicate += 1;
        continue;
      }
      if (client.remaining === 0) {
        stop = "request_cap";
        break;
      }
      const got = await client.get(url, { accept: "text/html, application/xhtml+xml, */*;q=0.1" });
      if (got.kind === "blocked") {
        if (got.reason === "request_cap") {
          stop = "request_cap";
          break;
        }
        state.urls.shift();
        state.posts_blocked += 1;
        continue;
      }
      counts.pages += 1;
      if (got.response.status === 429) {
        stop = "rate_limited";
        break;
      }
      state.urls.shift();
      if (got.response.status < 200 || got.response.status >= 300) {
        state.posts_blocked += 1;
        continue;
      }
      const meta = articleMetadata(got.response.bodyText);
      if (!meta.publishedAt || meta.publishedAt.getTime() > now.getTime()) {
        state.posts_undated += 1;
        continue;
      }
      if (meta.publishedAt.getTime() < cutoff) {
        state.posts_old += 1;
        continue;
      }
      const text = articleText(got.response.bodyText);
      const one = await ingestWebFeedPost(db, {
        site,
        post: {
          id: null,
          link: url,
          title: meta.title,
          publishedAt: meta.publishedAt,
          author: null,
          html: null,
          text,
          textSource: text ? "article" : "none",
        },
        feedUrl: "sitemap",
        index: input.index,
        now,
        discoveredVia: "sitemap",
      });
      if (one.status === "ingested") {
        counts.posts += 1;
        counts.mentions += one.mentions;
        counts.callsCreated += one.callsCreated;
        state.posts_ingested += 1;
        state.mentions += one.mentions;
        state.calls_created += one.callsCreated;
      } else {
        state.posts_duplicate += 1;
      }
    }
    if (state.urls.length === 0 && !stop) {
      state.phase = "done";
      state.outcome = state.urls_total > 0 ? "complete" : "no_posts_in_sitemaps";
    }
  }
  return { state, counts, stop };
}

/**
 * Advances the sitemap backfill of up to `maxSites` registered, active sites
 * that are not done yet and were not advanced within the interval, within
 * the shared daily `budget` and the per-site daily cap. Sites of creators an
 * operator excluded, and paused sites, are skipped.
 */
export async function runWebBackfillBatch(
  db: Database,
  input: {
    budget: number;
    perSiteDay: number;
    days: number;
    clientFor: (site: WebFeedSite) => WebFeedClient;
    maxSites?: number;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<WebBackfillReport> {
  const report = emptyReport();
  const now = input.now ?? new Date();
  const maxSites = Math.max(0, Math.min(input.maxSites ?? WEB_BACKFILL_MAX_SITES_PER_RUN, WEB_BACKFILL_MAX_SITES_PER_RUN));
  if (maxSites === 0 || input.budget < 1 || input.perSiteDay < 1 || input.days < 1) return { ...report, status: "skipped", reason: "no_budget" };

  const setup = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, input.env ?? process.env);
    if ((await getProviderRuntime(tx, "web_feed"))?.paused) return { skip: "paused" as const };
    const candidates = rowsOf<Candidate>(
      await tx.execute(sql`
        SELECT sa.id, sa.external_account_id AS domain, sa.display_name,
          sa.metadata->'web_feed' AS registration, latest.id AS previous_id, latest.checkpoint
        FROM source_account sa
        LEFT JOIN LATERAL (
          SELECT r.id, r.started_at, r.checkpoint FROM provider_sync_run r
          WHERE r.provider_key = 'web_feed' AND r."trigger" = ${WEB_BACKFILL_TRIGGER}
            AND r.checkpoint->>'account_id' = sa.id
          ORDER BY r.started_at DESC LIMIT 1
        ) latest ON true
        WHERE sa.source_type = 'web' AND sa.status = 'active'
          AND sa.metadata->'web_feed'->>'state' = 'active'
          AND COALESCE(latest.checkpoint->>'phase', '') <> 'done'
          AND (latest.started_at IS NULL OR latest.started_at <= now() - (${WEB_BACKFILL_INTERVAL_MINUTES}::int * interval '1 minute'))
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
    if (candidates.length === 0) return { skip: "nothing_to_backfill" as const };
    return { candidates, index: await loadCardNameIndex(tx) };
  });
  if ("skip" in setup) return { ...report, status: "skipped", reason: setup.skip ?? null };

  for (const candidate of setup.candidates) {
    const siteUrl = asRecord(candidate.registration).site_url;
    if (typeof siteUrl !== "string" || !siteUrl) continue;
    const site = { sourceAccountId: candidate.id, domain: candidate.domain, displayName: candidate.display_name, siteUrl };
    const client = input.clientFor(site);
    const reserve = Math.min(client.maxRequests, WEB_BACKFILL_MAX_REQUESTS_PER_SITE_RUN);
    const state = stateFrom(candidate.checkpoint, candidate.id, now, input.days);
    const claim = await claimSiteBackfill(db, { candidate, reserve, budget: input.budget, perSiteDay: input.perSiteDay, state });
    if (!claim.claimed) {
      if (claim.reason === "budget_exhausted") return { ...report, status: "stopped", reason: "budget_exhausted" };
      continue;
    }
    report.sites += 1;
    let result: Awaited<ReturnType<typeof advanceSite>>;
    let errorClass: string | null = null;
    try {
      result = await advanceSite(db, { client, site, state, index: setup.index, now });
    } catch {
      errorClass = "backfill_failed";
      result = { state, counts: { sitemaps: 0, pages: 0, posts: 0, mentions: 0, callsCreated: 0 }, stop: "backfill_failed" };
    }
    if (result.state.phase === "done") report.finished += 1;
    await withPlatformContext(db, (tx) =>
      tx
        .update(providerSyncRun)
        .set({
          status: errorClass ? "failed" : result.stop === "rate_limited" ? "skipped" : "completed",
          errorClass: errorClass ?? (result.stop === "rate_limited" ? "rate_limited" : null),
          limitCount: client.requests,
          receivedCount: result.counts.posts,
          completedAt: new Date(),
          checkpoint: {
            ...result.state,
            domain: candidate.domain,
            outcome: result.state.phase === "done" ? result.state.outcome : (result.stop ?? "in_progress"),
            requests: client.requests,
            run_sitemaps: result.counts.sitemaps,
            run_pages: result.counts.pages,
            run_posts: result.counts.posts,
          },
        })
        .where(eq(providerSyncRun.id, claim.runId)),
    );
    report.requests += client.requests;
    report.sitemaps += result.counts.sitemaps;
    report.pages += result.counts.pages;
    report.posts += result.counts.posts;
    report.mentions += result.counts.mentions;
    report.callsCreated += result.counts.callsCreated;
  }
  return report;
}

/**
 * The worker's website backfill step: runs only with WEB_FEED_BACKFILL_DAYS
 * set and PROVIDER_WEB_FEED_MODE=live, honoring the web_feed provider's pause
 * and (hosted) enable controls.
 */
export async function runWebBackfill(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; lookup?: DnsLookup | null; now?: Date; maxSites?: number } = {},
): Promise<WebBackfillReport> {
  const env = input.env ?? process.env;
  const config = webBackfillConfig(env);
  if (!config.enabled) return { ...emptyReport(), status: "skipped", reason: "disabled" };
  if (resolveProviderMode("web_feed", env) !== "live") return { ...emptyReport(), status: "skipped", reason: "web_feed_not_live" };
  const runtime = await withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    return getProviderRuntime(tx, "web_feed");
  });
  if (runtime?.paused || (isHostedRuntime(env) && !runtime?.enabled)) {
    return { ...emptyReport(), status: "skipped", reason: "paused_or_disabled" };
  }
  return runWebBackfillBatch(db, {
    budget: webFeedRequestBudget(env),
    perSiteDay: config.perSiteDay,
    days: config.days,
    env,
    now: input.now,
    maxSites: input.maxSites,
    clientFor: () =>
      new WebFeedClient({ transport: input.transport, lookup: input.lookup, env, maxRequests: WEB_BACKFILL_MAX_REQUESTS_PER_SITE_RUN }),
  });
}

export type WebBackfillSiteRow = {
  sourceAccountId: string;
  domain: string | null;
  phase: string;
  outcome: string | null;
  urlsFound: number;
  urlsQueued: number;
  postsIngested: number;
  mentions: number;
  callsCreated: number;
  lastRunAt: Date | null;
};

/** Each site's sitemap backfill progress (its newest run), for the admin page. */
export async function listWebBackfillProgress(db: Database, limit = 200): Promise<WebBackfillSiteRow[]> {
  const rows = await withPlatformContext(db, async (tx) =>
    rowsOf<{ account_id: string; checkpoint: unknown; started_at: Date | string | null }>(
      await tx.execute(sql`
        SELECT DISTINCT ON (checkpoint->>'account_id') checkpoint->>'account_id' AS account_id, checkpoint, started_at
        FROM provider_sync_run
        WHERE provider_key = 'web_feed' AND "trigger" = ${WEB_BACKFILL_TRIGGER}
        ORDER BY checkpoint->>'account_id', started_at DESC
        LIMIT ${Math.max(1, Math.min(limit, 500))}`),
    ),
  );
  return rows.map((row) => {
    const cp = asRecord(row.checkpoint);
    const num = (key: string) => (Number.isFinite(Number(cp[key])) ? Number(cp[key]) : 0);
    return {
      sourceAccountId: row.account_id,
      domain: typeof cp.domain === "string" ? cp.domain : null,
      phase: typeof cp.phase === "string" ? cp.phase : "discover",
      outcome: typeof cp.outcome === "string" ? cp.outcome : null,
      urlsFound: num("urls_total"),
      urlsQueued: Array.isArray(cp.urls) ? cp.urls.length : 0,
      postsIngested: num("posts_ingested"),
      mentions: num("mentions"),
      callsCreated: num("calls_created"),
      lastRunAt: row.started_at == null ? null : new Date(row.started_at),
    };
  });
}
