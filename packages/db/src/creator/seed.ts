/**
 * Operator seed list of influencers (optional seeds, never a prerequisite for
 * discovery). An operator asks for the list to be registered from the admin
 * sources page:
 *
 * - each website or newsletter goes through registerWebFeedSite at once (no
 *   network request; the hourly web feed step reads it later);
 * - each YouTube channel id or @handle becomes a pending entry that the
 *   worker resolves through the YouTube Data API (channels?id= /
 *   channels?forHandle=, one budgeted data request each, never a search) and
 *   then monitors like a followed creator. A row without a usable id or
 *   handle is reported as such; nothing is ever guessed from a name.
 *
 * State: no new table. Every seed entry is one provider_sync_run row
 * (trigger `influencer_seed`, provider `youtube` or `web_feed`, id `pis_…`)
 * whose status is the entry's state (started = waiting for the worker) and
 * whose checkpoint carries rank, name, input and outcome. Re-running the seed
 * is idempotent: settled rows are kept, failed lookups are queued again and a
 * website that is already registered (or paused) is left as it is.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { insertBreakGlassAudit } from "../platform/audit.js";
import { providerCredentialStatus, resolveProviderMode } from "../providers/catalog.js";
import { budgetedDiscoveryTransport, DiscoveryBudgetError } from "../providers/discovery-budget.js";
import { siteDomain } from "../providers/live-google.js";
import { createLiveYoutubeProvider } from "../providers/live-social.js";
import { ensureProviderRuntimeRows, getProviderRuntime } from "../providers/runtime.js";
import { ProviderHttpError, type HttpTransport } from "../providers/transport.js";
import { withPlatformContext } from "../rls.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceAccount } from "../schema/source.js";
import { stableSourceId } from "../source/identity.js";
import { registerWebFeedSite, webFeedAccountId, WebFeedSiteError } from "../source/web-feed-ingest.js";
import { ensureCreatorForSourceAccount } from "./ingest.js";
import { ensureRequestedCreatorMonitored } from "./list.js";
import { POKEMON_INFLUENCER_SEED_VERSION, POKEMON_INFLUENCER_SEEDS } from "./seed/pokemon-influencers.js";

export { POKEMON_INFLUENCER_SEED_VERSION, POKEMON_INFLUENCER_SEEDS } from "./seed/pokemon-influencers.js";

export const INFLUENCER_SEED_TRIGGER = "influencer_seed";
export const INFLUENCER_SEED_ID_PREFIX = "pis_";
/** YouTube lookups per worker tick; each is one budgeted data request. */
export const INFLUENCER_SEED_LOOKUPS_PER_RUN = 5;
export const INFLUENCER_SEED_MAX_ATTEMPTS = 3;

/**
 * Hosts where one domain holds many unrelated creators (each creator is a
 * path), so registering the domain would merge them into one website creator.
 * Patreon also has no public RSS for creator posts.
 */
export const SHARED_PLATFORM_DOMAINS = ["patreon.com", "ko-fi.com", "buymeacoffee.com", "linktr.ee", "medium.com"] as const;

export type InfluencerSeedEntry = {
  rank: number;
  name: string;
  youtubeChannelId: string | null;
  youtubeHandle: string | null;
  youtubeUrl: string | null;
  websiteUrl: string | null;
  feedUrl: string | null;
  newsletterUrl: string | null;
  makesSpecificCalls: string;
};

const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;

export type PlannedSeedChannel = {
  kind: "youtube";
  rank: number;
  name: string;
  /** Channel id or @handle to look up; null when the row has none. */
  input: string | null;
  /** Why there is nothing to look up. */
  skip: "no_handle" | "custom_url" | null;
};

export type PlannedSeedSite = {
  kind: "website";
  rank: number;
  name: string;
  siteUrl: string;
  feedUrl: string | null;
  domain: string | null;
  skip: "shared_platform" | "invalid_url" | null;
};

function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return siteDomain(new URL(raw).hostname);
  } catch {
    return null;
  }
}

function isSharedPlatform(domain: string) {
  return SHARED_PLATFORM_DOMAINS.some((root) => domain === root || domain.endsWith(`.${root}`));
}

/**
 * What registering the list would do, entry by entry. Pure. A row with a
 * channel id or @handle gets one YouTube lookup (the id wins over the handle);
 * legacy /c/ and /user/ URLs cannot be looked up without a search request and
 * are reported. Website and newsletter URLs on the same domain become one
 * site; the feed URL goes with the site on its domain.
 */
export function planInfluencerSeed(entries: readonly InfluencerSeedEntry[]): {
  channels: PlannedSeedChannel[];
  sites: PlannedSeedSite[];
} {
  const channels: PlannedSeedChannel[] = [];
  const sites: PlannedSeedSite[] = [];
  for (const entry of entries) {
    const id = entry.youtubeChannelId && YOUTUBE_CHANNEL_ID.test(entry.youtubeChannelId) ? entry.youtubeChannelId : null;
    const handle = entry.youtubeHandle && YOUTUBE_HANDLE.test(entry.youtubeHandle) ? entry.youtubeHandle.toLowerCase() : null;
    const input = id ?? handle;
    if (input || entry.youtubeUrl) {
      channels.push({
        kind: "youtube",
        rank: entry.rank,
        name: entry.name,
        input,
        skip: input ? null : "custom_url",
      });
    } else {
      channels.push({ kind: "youtube", rank: entry.rank, name: entry.name, input: null, skip: "no_handle" });
    }
    const seen = new Set<string>();
    for (const url of [entry.websiteUrl, entry.newsletterUrl]) {
      if (!url) continue;
      const domain = hostOf(url);
      const key = domain ?? url;
      if (seen.has(key)) continue;
      seen.add(key);
      const feedDomain = hostOf(entry.feedUrl);
      sites.push({
        kind: "website",
        rank: entry.rank,
        name: entry.name,
        siteUrl: url,
        feedUrl: entry.feedUrl && feedDomain && feedDomain === domain ? entry.feedUrl : null,
        domain,
        skip: !domain ? "invalid_url" : isSharedPlatform(domain) ? "shared_platform" : null,
      });
    }
  }
  return { channels, sites };
}

export function influencerSeedRowId(kind: "youtube" | "website", rank: number, key: string) {
  return `${INFLUENCER_SEED_ID_PREFIX}${createHash("sha256").update(`${kind}|${rank}|${key.toLowerCase()}`).digest("hex").slice(0, 32)}`;
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export type InfluencerSeedRequestReport = {
  version: string;
  channelsQueued: number;
  channelsSkipped: number;
  sitesRegistered: number;
  sitesAlreadyRegistered: number;
  sitesSkipped: number;
};

async function insertSeedRow(
  tx: Database,
  input: {
    id: string;
    providerKey: "youtube" | "web_feed";
    status: "started" | "completed" | "skipped";
    checkpoint: Record<string, unknown>;
    requeueFailed?: boolean;
  },
): Promise<boolean> {
  const inserted = rowsOf<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO provider_sync_run (id, provider_key, mode, "trigger", status, limit_count, checkpoint, completed_at)
      VALUES (${input.id}, ${input.providerKey}, 'live', ${INFLUENCER_SEED_TRIGGER}, ${input.status}, 0,
        ${JSON.stringify(input.checkpoint)}::jsonb, ${input.status === "started" ? null : new Date().toISOString()}::timestamptz)
      ON CONFLICT (id) DO ${
        input.requeueFailed
          ? sql`UPDATE SET status = 'started', error_class = NULL, completed_at = NULL, started_at = now(),
              checkpoint = provider_sync_run.checkpoint - 'next_attempt_at' || jsonb_build_object('attempts', 0, 'outcome', 'pending')
            WHERE provider_sync_run.status = 'failed'`
          : sql`NOTHING`
      }
      RETURNING id`),
  );
  return inserted.length > 0;
}

/**
 * Registers the seed list (operator action). Websites are registered now;
 * YouTube entries are queued for the worker. Writes one break-glass audit row
 * for the request (each new website also gets its own, from
 * registerWebFeedSite). Idempotent.
 */
export async function requestInfluencerSeed(
  db: Database,
  input: { actorUserId: string; env?: NodeJS.ProcessEnv; entries?: readonly InfluencerSeedEntry[]; version?: string },
): Promise<InfluencerSeedRequestReport> {
  const env = input.env ?? process.env;
  const version = input.version ?? POKEMON_INFLUENCER_SEED_VERSION;
  const plan = planInfluencerSeed(input.entries ?? POKEMON_INFLUENCER_SEEDS);
  return withPlatformContext(db, async (tx) => {
    await ensureProviderRuntimeRows(tx, env);
    const report: InfluencerSeedRequestReport = {
      version,
      channelsQueued: 0,
      channelsSkipped: 0,
      sitesRegistered: 0,
      sitesAlreadyRegistered: 0,
      sitesSkipped: 0,
    };
    for (const channel of plan.channels) {
      const base = { kind: "youtube", rank: channel.rank, name: channel.name, input: channel.input, seed_version: version };
      if (!channel.input) {
        await insertSeedRow(tx, {
          id: influencerSeedRowId("youtube", channel.rank, `none:${channel.name}`),
          providerKey: "youtube",
          status: "skipped",
          checkpoint: { ...base, outcome: channel.skip },
        });
        report.channelsSkipped += 1;
        continue;
      }
      const queued = await insertSeedRow(tx, {
        id: influencerSeedRowId("youtube", channel.rank, channel.input),
        providerKey: "youtube",
        status: "started",
        checkpoint: { ...base, outcome: "pending", attempts: 0 },
        requeueFailed: true,
      });
      if (queued) report.channelsQueued += 1;
    }
    for (const site of plan.sites) {
      const id = influencerSeedRowId("website", site.rank, site.domain ?? site.siteUrl);
      const base = { kind: "website", rank: site.rank, name: site.name, input: site.siteUrl, feed_url: site.feedUrl, seed_version: version };
      if (site.skip || !site.domain) {
        await insertSeedRow(tx, { id, providerKey: "web_feed", status: "skipped", checkpoint: { ...base, outcome: site.skip ?? "invalid_url" } });
        report.sitesSkipped += 1;
        continue;
      }
      const [existing] = await tx
        .select({ metadata: sourceAccount.metadata })
        .from(sourceAccount)
        .where(eq(sourceAccount.id, webFeedAccountId(site.domain)))
        .limit(1);
      if (existing?.metadata.web_feed) {
        // Already registered (possibly paused by an operator): never re-activated here.
        await insertSeedRow(tx, {
          id,
          providerKey: "web_feed",
          status: "completed",
          checkpoint: { ...base, outcome: "already_registered", source_account_id: webFeedAccountId(site.domain) },
        });
        report.sitesAlreadyRegistered += 1;
        continue;
      }
      try {
        const registered = await registerWebFeedSite(tx, {
          siteUrl: site.siteUrl,
          feedUrl: site.feedUrl,
          displayName: site.name,
          actorUserId: input.actorUserId,
          env,
        });
        await insertSeedRow(tx, {
          id,
          providerKey: "web_feed",
          status: "completed",
          checkpoint: {
            ...base,
            outcome: "registered",
            source_account_id: registered.sourceAccountId,
            creator_id: registered.creatorId,
          },
        });
        report.sitesRegistered += 1;
      } catch (error) {
        if (!(error instanceof WebFeedSiteError)) throw error;
        await insertSeedRow(tx, { id, providerKey: "web_feed", status: "skipped", checkpoint: { ...base, outcome: error.code } });
        report.sitesSkipped += 1;
      }
    }
    await insertBreakGlassAudit(tx, {
      actorUserId: input.actorUserId,
      action: "discovery.monitor",
      targetType: "influencer_seed",
      targetId: version,
      metadata: {
        change: "influencer_seed.request",
        channels_queued: report.channelsQueued,
        channels_skipped: report.channelsSkipped,
        sites_registered: report.sitesRegistered,
        sites_already_registered: report.sitesAlreadyRegistered,
        sites_skipped: report.sitesSkipped,
      },
    });
    return report;
  });
}

export type InfluencerSeedRow = {
  id: string;
  kind: "youtube" | "website";
  rank: number;
  name: string;
  input: string | null;
  status: string;
  outcome: string | null;
  errorClass: string | null;
  creatorId: string | null;
  externalAccountId: string | null;
  updatedAt: Date | null;
};

/** Every seed entry with its state, by rank, for the admin page. */
export async function listInfluencerSeedStatus(db: Database, limit = 300): Promise<InfluencerSeedRow[]> {
  const rows = rowsOf<{
    id: string;
    status: string;
    error_class: string | null;
    checkpoint: unknown;
    started_at: Date | string | null;
    completed_at: Date | string | null;
  }>(
    await db.execute(sql`
      SELECT id, status, error_class, checkpoint, started_at, completed_at FROM provider_sync_run
      WHERE "trigger" = ${INFLUENCER_SEED_TRIGGER}
      ORDER BY (checkpoint->>'rank')::int NULLS LAST, checkpoint->>'kind' DESC, id
      LIMIT ${Math.max(1, Math.min(limit, 500))}`),
  );
  return rows.map((row) => {
    const checkpoint = asRecord(row.checkpoint);
    const text = (key: string) => (typeof checkpoint[key] === "string" ? (checkpoint[key] as string) : null);
    const at = row.completed_at ?? row.started_at;
    return {
      id: row.id,
      kind: checkpoint.kind === "website" ? "website" : "youtube",
      rank: Number(checkpoint.rank) || 0,
      name: text("name") ?? "",
      input: text("input"),
      status: row.status,
      outcome: text("outcome"),
      errorClass: row.error_class,
      creatorId: text("creator_id"),
      externalAccountId: text("external_account_id"),
      updatedAt: at ? new Date(at) : null,
    };
  });
}

export type InfluencerSeedResolutionReport = {
  status: "completed" | "skipped";
  resolved: number;
  notFound: number;
  blocked: number;
  failed: number;
  requests: number;
  reason?: string;
};

async function finishSeedRow(
  db: Database,
  id: string,
  input: { status: "started" | "completed" | "skipped" | "failed"; errorClass?: string | null; checkpoint: Record<string, unknown> },
) {
  await withPlatformContext(db, (tx) =>
    tx
      .update(providerSyncRun)
      .set({
        status: input.status,
        errorClass: input.errorClass ?? null,
        completedAt: input.status === "started" ? null : new Date(),
        checkpoint: sql`${providerSyncRun.checkpoint} || ${JSON.stringify(input.checkpoint)}::jsonb`,
      })
      .where(eq(providerSyncRun.id, id)),
  );
}

/**
 * Resolves up to `limit` queued YouTube seed entries (worker; runs inside the
 * YouTube provider's scheduled sync, under its lease and daily data-request
 * budget). Each lookup is one channels.list request by id or handle. A found
 * channel gets its canonical account and creator and is monitored unless an
 * operator excluded it; a missing one is reported as not found.
 */
export async function resolvePendingInfluencerSeeds(
  db: Database,
  input: { env?: NodeJS.ProcessEnv; transport?: HttpTransport; limit?: number } = {},
): Promise<InfluencerSeedResolutionReport> {
  const env = input.env ?? process.env;
  const empty = { resolved: 0, notFound: 0, blocked: 0, failed: 0, requests: 0 };
  if (resolveProviderMode("youtube", env) !== "live" || !providerCredentialStatus("youtube", env).present) {
    return { status: "skipped", ...empty, reason: "not_live_or_credentialed" };
  }
  const limit = Math.max(1, Math.min(input.limit ?? INFLUENCER_SEED_LOOKUPS_PER_RUN, INFLUENCER_SEED_LOOKUPS_PER_RUN));
  const pending = await withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, "youtube");
    if (!runtime?.enabled || runtime.paused || runtime.mode !== "live" || (runtime.retryAfterAt && runtime.retryAfterAt > new Date())) {
      return null;
    }
    const rows = rowsOf<{ id: string; checkpoint: unknown }>(
      await tx.execute(sql`
        SELECT id, checkpoint FROM provider_sync_run
        WHERE provider_key = 'youtube' AND "trigger" = ${INFLUENCER_SEED_TRIGGER} AND status = 'started'
          AND COALESCE((checkpoint->>'next_attempt_at')::timestamptz, '-infinity'::timestamptz) <= now()
        ORDER BY (checkpoint->>'rank')::int NULLS LAST, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`),
    );
    // Claimed for an hour, so a crash cannot loop on the same entry.
    for (const row of rows) {
      await tx.execute(sql`
        UPDATE provider_sync_run
        SET checkpoint = checkpoint || jsonb_build_object('next_attempt_at', (now() + interval '1 hour')::text)
        WHERE id = ${row.id}`);
    }
    return rows.map((row) => ({ id: row.id, checkpoint: asRecord(row.checkpoint) }));
  });
  if (!pending) return { status: "skipped", ...empty, reason: "paused_or_disabled" };
  if (pending.length === 0) return { status: "skipped", ...empty, reason: "no_pending_seeds" };

  const budget = budgetedDiscoveryTransport(db, "youtube", env, input.transport);
  const youtube = createLiveYoutubeProvider(env, budget.transport)!;
  const report = { ...empty };
  for (const row of pending) {
    const lookup = typeof row.checkpoint.input === "string" ? row.checkpoint.input : "";
    const attempts = (Number(row.checkpoint.attempts) || 0) + 1;
    let found: Awaited<ReturnType<typeof youtube.resolveChannel>>;
    try {
      found = await youtube.resolveChannel(lookup);
    } catch (error) {
      if (error instanceof DiscoveryBudgetError) {
        report.requests = budget.requestCount();
        return { status: "skipped", ...report, reason: "budget_exhausted" };
      }
      const errorClass = error instanceof ProviderHttpError ? error.errorClass : "lookup_failed";
      if (errorClass === "invalid_account") {
        await finishSeedRow(db, row.id, { status: "skipped", checkpoint: { outcome: "not_found", attempts } });
        report.notFound += 1;
      } else if (attempts >= INFLUENCER_SEED_MAX_ATTEMPTS) {
        await finishSeedRow(db, row.id, { status: "failed", errorClass, checkpoint: { outcome: "lookup_failed", attempts } });
        report.failed += 1;
      } else {
        // Stays queued; the claim above already delays the retry by an hour.
        await finishSeedRow(db, row.id, { status: "started", errorClass, checkpoint: { outcome: "retrying", attempts } });
        report.failed += 1;
      }
      continue;
    }
    if (!found) {
      await finishSeedRow(db, row.id, { status: "skipped", checkpoint: { outcome: "not_found", attempts } });
      report.notFound += 1;
      continue;
    }
    const channel = found;
    const outcome = await withPlatformContext(db, async (tx) => {
      const accountId = stableSourceId("sac", ["youtube", channel.external_account_id]);
      const now = new Date();
      await tx
        .insert(sourceAccount)
        .values({
          id: accountId,
          sourceType: "youtube",
          externalAccountId: channel.external_account_id,
          handle: channel.handle,
          displayName: channel.display_name,
          canonicalUrl: `https://www.youtube.com/channel/${channel.external_account_id}`,
          metadata: { added_by: "influencer_seed" },
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();
      const [stored] = await tx
        .select({ id: sourceAccount.id })
        .from(sourceAccount)
        .where(and(eq(sourceAccount.sourceType, "youtube"), eq(sourceAccount.externalAccountId, channel.external_account_id)))
        .limit(1);
      const linked = await ensureCreatorForSourceAccount(tx, stored!.id);
      const seed = { seed_rank: Number(row.checkpoint.rank) || null, seed_version: row.checkpoint.seed_version ?? null };
      const state = await ensureRequestedCreatorMonitored(tx, {
        providerKey: "youtube",
        creatorId: linked.creator.id,
        sourceAccountId: stored!.id,
        externalAccountId: channel.external_account_id,
        displayName: channel.display_name,
        // Being on the seed list only schedules polling and the backfill; it is never authority.
        marker: { operator_seed: true, ...seed },
        provenance: { operator_seed: true, source: "operator_seed", ...seed },
      });
      return { state, creatorId: linked.creator.id };
    });
    await finishSeedRow(db, row.id, {
      status: outcome.state === "blocked" ? "skipped" : "completed",
      checkpoint: {
        outcome: outcome.state === "blocked" ? "excluded_by_operator" : "resolved",
        attempts,
        external_account_id: channel.external_account_id,
        channel_title: channel.display_name,
        creator_id: outcome.creatorId,
      },
    });
    if (outcome.state === "blocked") report.blocked += 1;
    else report.resolved += 1;
  }
  report.requests = budget.requestCount();
  return { status: "completed", ...report };
}
