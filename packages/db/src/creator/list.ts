import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { creator, creatorSourceAccount } from "../schema/creator.js";
import { tenantCreatorList } from "../schema/creator-list.js";
import { discoveredCreator, type DiscoveryProviderKey } from "../schema/discovery.js";
import { sourceAccount } from "../schema/source.js";
import { stableSourceId } from "../source/identity.js";
import { latestTrustState } from "./authority.js";
import { ensureCreatorForSourceAccount } from "./ingest.js";
import { stableDiscoveryId } from "../providers/discovery.js";
import { providerCredentialStatus, resolveProviderMode } from "../providers/catalog.js";
import { getProviderRuntime } from "../providers/runtime.js";
import { budgetedDiscoveryTransport, DiscoveryBudgetError } from "../providers/discovery-budget.js";
import { createLiveRedditProvider, createLiveYoutubeProvider } from "../providers/live-social.js";
import { ProviderHttpError, type HttpTransport } from "../providers/transport.js";

// A workspace's private influencer list. Following asks the platform to keep a
// creator monitored; hiding filters this workspace's views. Neither ever changes
// a creator's authority, trust or the operator's global exclusions.

export type CreatorPlatform = "youtube" | "reddit";
export type CreatorPreference = "follow" | "hide";

export const TENANT_CREATOR_LIST_MAX = 200;

export class CreatorHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorHandleError";
  }
}

export class CreatorListLimitError extends Error {
  constructor() {
    super(`A workspace can list at most ${TENANT_CREATOR_LIST_MAX} creators.`);
    this.name = "CreatorListLimitError";
  }
}

const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const REDDIT_USER = /^[A-Za-z0-9_-]{3,20}$/;

/**
 * Parse what a person pastes: a YouTube channel URL, @handle or channel ID, or
 * a Reddit profile URL or u/name. Custom /c/ and /user/ YouTube URLs cannot be
 * resolved without a search request, so they are rejected with a hint.
 */
export function parseCreatorHandle(input: string, platformHint?: CreatorPlatform): { platform: CreatorPlatform; handle: string } {
  const raw = input.trim();
  if (!raw || raw.length > 300) throw new CreatorHandleError("Paste a YouTube channel or Reddit profile link.");
  let url: URL | null = null;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : /^(www\.|m\.)?(youtube\.com|reddit\.com|old\.reddit\.com)\//i.test(raw) ? `https://${raw}` : "");
  } catch {
    url = null;
  }
  if (url) {
    const host = url.hostname.toLowerCase().replace(/^(www|m|old)\./, "");
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (host === "youtube.com") {
      if (parts[0] === "channel" && parts[1] && YOUTUBE_CHANNEL_ID.test(parts[1])) return { platform: "youtube", handle: parts[1] };
      if (parts[0]?.startsWith("@") && YOUTUBE_HANDLE.test(parts[0])) return { platform: "youtube", handle: parts[0].toLowerCase() };
      throw new CreatorHandleError("Use the channel's @handle link, for example youtube.com/@name.");
    }
    if (host === "reddit.com") {
      if ((parts[0] === "user" || parts[0] === "u") && parts[1] && REDDIT_USER.test(parts[1])) return { platform: "reddit", handle: parts[1] };
      throw new CreatorHandleError("Use a Reddit profile link, for example reddit.com/user/name.");
    }
    throw new CreatorHandleError("Only YouTube channels and Reddit profiles can be added.");
  }
  if (YOUTUBE_CHANNEL_ID.test(raw)) return { platform: "youtube", handle: raw };
  const reddit = raw.match(/^\/?u\/([A-Za-z0-9_-]{3,20})$/i);
  if (reddit) return { platform: "reddit", handle: reddit[1]! };
  if (platformHint === "youtube" && YOUTUBE_HANDLE.test(raw.startsWith("@") ? raw : `@${raw}`)) {
    return { platform: "youtube", handle: (raw.startsWith("@") ? raw : `@${raw}`).toLowerCase() };
  }
  if (platformHint === "reddit" && REDDIT_USER.test(raw)) return { platform: "reddit", handle: raw };
  if (YOUTUBE_HANDLE.test(raw)) return { platform: "youtube", handle: raw.toLowerCase() };
  throw new CreatorHandleError("Paste a YouTube channel or Reddit profile link.");
}

export type TenantCreatorListRow = {
  id: string;
  platform: CreatorPlatform;
  inputHandle: string | null;
  creatorId: string | null;
  creatorName: string | null;
  preference: CreatorPreference;
  status: string;
  errorClass: string | null;
  createdAt: Date;
};

/** Runs inside withOrganizationContext; RLS limits rows to the workspace. */
export async function listTenantCreatorList(db: Database): Promise<TenantCreatorListRow[]> {
  const rows = await db
    .select({
      id: tenantCreatorList.id,
      platform: tenantCreatorList.platform,
      inputHandle: tenantCreatorList.inputHandle,
      creatorId: tenantCreatorList.creatorId,
      creatorName: creator.displayName,
      preference: tenantCreatorList.preference,
      status: tenantCreatorList.status,
      errorClass: tenantCreatorList.errorClass,
      createdAt: tenantCreatorList.createdAt,
    })
    .from(tenantCreatorList)
    .leftJoin(creator, eq(creator.id, tenantCreatorList.creatorId))
    .orderBy(sql`${tenantCreatorList.createdAt} DESC`, tenantCreatorList.id)
    .limit(TENANT_CREATOR_LIST_MAX);
  return rows.map((row) => ({
    ...row,
    platform: row.platform as CreatorPlatform,
    preference: row.preference as CreatorPreference,
  }));
}

/** Creator ids this workspace has hidden. Runs inside withOrganizationContext. */
export async function listHiddenCreatorIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ creatorId: tenantCreatorList.creatorId })
    .from(tenantCreatorList)
    .where(and(eq(tenantCreatorList.preference, "hide"), sql`${tenantCreatorList.creatorId} IS NOT NULL`))
    .limit(TENANT_CREATOR_LIST_MAX);
  return rows.map((row) => row.creatorId!).filter(Boolean);
}

async function assertBelowLimit(db: Database) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(tenantCreatorList);
  if (Number(row?.count ?? 0) >= TENANT_CREATOR_LIST_MAX) throw new CreatorListLimitError();
}

/** Follow or hide a creator already known to the platform. Upserts per workspace. */
export async function setCreatorPreference(
  db: Database,
  input: { organizationId: string; userId: string; creatorId: string; preference: CreatorPreference },
) {
  const [known] = await db
    .select({ creatorId: creatorSourceAccount.creatorId, sourceType: sourceAccount.sourceType })
    .from(creatorSourceAccount)
    .innerJoin(sourceAccount, eq(sourceAccount.id, creatorSourceAccount.sourceAccountId))
    .where(eq(creatorSourceAccount.creatorId, input.creatorId))
    .limit(1);
  if (!known) throw new CreatorHandleError("That creator is not known yet.");
  const platform: CreatorPlatform = known.sourceType === "reddit" ? "reddit" : "youtube";
  const [existing] = await db
    .select({ id: tenantCreatorList.id })
    .from(tenantCreatorList)
    .where(eq(tenantCreatorList.creatorId, input.creatorId))
    .limit(1);
  if (existing) {
    await db
      .update(tenantCreatorList)
      .set({ preference: input.preference, updatedAt: new Date() })
      .where(eq(tenantCreatorList.id, existing.id));
    return { id: existing.id, created: false };
  }
  await assertBelowLimit(db);
  const id = `tcl_${randomUUID()}`;
  await db.insert(tenantCreatorList).values({
    id,
    organizationId: input.organizationId,
    createdByUserId: input.userId,
    platform,
    creatorId: input.creatorId,
    preference: input.preference,
    status: "resolved",
  });
  return { id, created: true };
}

/**
 * Ask to follow a creator by link or handle. A channel ID or Reddit name the
 * platform already knows resolves at once; anything else waits for the worker,
 * which resolves it under the provider's request budget.
 */
export async function requestCreatorFollow(
  db: Database,
  input: { organizationId: string; userId: string; input: string; platform?: CreatorPlatform },
) {
  const parsed = parseCreatorHandle(input.input, input.platform);
  const exactId = parsed.platform === "reddit" || YOUTUBE_CHANNEL_ID.test(parsed.handle) ? parsed.handle : null;
  if (exactId) {
    const [known] = await db
      .select({ creatorId: creatorSourceAccount.creatorId })
      .from(sourceAccount)
      .innerJoin(creatorSourceAccount, eq(creatorSourceAccount.sourceAccountId, sourceAccount.id))
      .where(
        and(
          eq(sourceAccount.sourceType, parsed.platform),
          parsed.platform === "reddit"
            ? sql`lower(${sourceAccount.externalAccountId}) = lower(${exactId})`
            : eq(sourceAccount.externalAccountId, exactId),
        ),
      )
      .limit(1);
    if (known) {
      const result = await setCreatorPreference(db, { ...input, creatorId: known.creatorId, preference: "follow" });
      return { ...result, status: "resolved" as const, platform: parsed.platform };
    }
  }
  const [duplicate] = await db
    .select({ id: tenantCreatorList.id, status: tenantCreatorList.status })
    .from(tenantCreatorList)
    .where(
      and(
        eq(tenantCreatorList.platform, parsed.platform),
        sql`lower(${tenantCreatorList.inputHandle}) = lower(${parsed.handle})`,
      ),
    )
    .limit(1);
  if (duplicate) {
    // Asking again after a failed lookup retries it.
    if (duplicate.status !== "resolved" && duplicate.status !== "pending") {
      await db
        .update(tenantCreatorList)
        .set({ status: "pending", errorClass: null, preference: "follow", updatedAt: new Date() })
        .where(eq(tenantCreatorList.id, duplicate.id));
    }
    return { id: duplicate.id, created: false, status: "pending" as const, platform: parsed.platform };
  }
  await assertBelowLimit(db);
  const id = `tcl_${randomUUID()}`;
  await db.insert(tenantCreatorList).values({
    id,
    organizationId: input.organizationId,
    createdByUserId: input.userId,
    platform: parsed.platform,
    inputHandle: parsed.handle,
    preference: "follow",
    status: "pending",
  });
  return { id, created: true, status: "pending" as const, platform: parsed.platform };
}

/** Remove one entry. Runs inside withOrganizationContext; RLS scopes the delete. */
export async function removeFromCreatorList(db: Database, id: string) {
  const result = await db.delete(tenantCreatorList).where(eq(tenantCreatorList.id, id)).returning({ id: tenantCreatorList.id });
  return result.length > 0;
}

// ---------- Worker side ----------

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Make sure the creator behind an account a person asked to track (a
 * workspace follow, an operator's seed list) is monitored, without ever
 * overriding the operator. Returns "blocked" when the operator excluded them.
 * `marker` is merged into the provenance; it schedules polling and is never
 * relevance or authority evidence.
 */
export async function ensureRequestedCreatorMonitored(
  db: Database,
  input: {
    providerKey: DiscoveryProviderKey;
    creatorId: string;
    sourceAccountId: string;
    externalAccountId: string;
    displayName: string | null;
    marker: Record<string, unknown>;
    provenance: Record<string, unknown>;
  },
): Promise<"monitored" | "blocked"> {
  if ((await latestTrustState(db, input.creatorId)) === "excluded") return "blocked";
  const [existing] = await db
    .select()
    .from(discoveredCreator)
    .where(and(eq(discoveredCreator.providerKey, input.providerKey), eq(discoveredCreator.externalAccountId, input.externalAccountId)))
    .limit(1);
  if (existing) {
    if (existing.relevanceState === "excluded") return "blocked";
    if (existing.relevanceState !== "monitored") {
      await db
        .update(discoveredCreator)
        .set({
          relevanceState: "monitored",
          discoveryProvenance: { ...existing.discoveryProvenance, ...input.marker },
        })
        .where(eq(discoveredCreator.id, existing.id));
    }
    return "monitored";
  }
  await db.insert(discoveredCreator).values({
    id: stableDiscoveryId("dcr", [input.providerKey, input.externalAccountId]),
    creatorId: input.creatorId,
    sourceAccountId: input.sourceAccountId,
    providerKey: input.providerKey,
    externalAccountId: input.externalAccountId,
    displayName: input.displayName,
    topicHits: 0,
    relevanceScore: "0",
    relevanceState: "monitored",
    discoveryProvenance: input.provenance,
  });
  return "monitored";
}

function ensureFollowedMonitored(
  db: Database,
  input: { providerKey: DiscoveryProviderKey; creatorId: string; sourceAccountId: string; externalAccountId: string; displayName: string | null },
) {
  // Following is not relevance or authority evidence; it only schedules polling.
  return ensureRequestedCreatorMonitored(db, {
    ...input,
    marker: { followed_by_workspace: true },
    provenance: { followed_by_workspace: true, source: "workspace_follow" },
  });
}

/** Keep creators a workspace followed monitored. No provider requests. */
export async function promoteFollowedCreators(db: Database, providerKey: DiscoveryProviderKey) {
  return withPlatformContext(db, async (tx) => {
    const ids = rowsOf<{ creator_id: string }>(await tx.execute(sql`SELECT creator_id FROM app.list_followed_creator_ids(500)`))
      .map((row) => row.creator_id);
    if (ids.length === 0) return 0;
    const rows = await tx
      .select({ id: discoveredCreator.id, provenance: discoveredCreator.discoveryProvenance, creatorId: discoveredCreator.creatorId })
      .from(discoveredCreator)
      .where(
        sql`${discoveredCreator.providerKey} = ${providerKey}
          AND ${discoveredCreator.relevanceState} IN ('candidate', 'low_confidence')
          AND ${discoveredCreator.creatorId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
      )
      .limit(50);
    let promoted = 0;
    for (const row of rows) {
      if ((await latestTrustState(tx, row.creatorId)) === "excluded") continue;
      await tx
        .update(discoveredCreator)
        .set({ relevanceState: "monitored", discoveryProvenance: { ...row.provenance, followed_by_workspace: true } })
        .where(eq(discoveredCreator.id, row.id));
      promoted += 1;
    }
    return promoted;
  });
}

export type CreatorFollowResolutionReport = {
  status: "completed" | "skipped" | "failed";
  resolved: number;
  notFound: number;
  blocked: number;
  requests: number;
  reason?: string;
};

/**
 * Resolve up to `limit` pending follow requests for one provider. Each lookup is
 * one budgeted data request (never a search request). Lookups for a handle the
 * platform already knows cost nothing.
 */
export async function resolvePendingCreatorFollows(
  db: Database,
  input: { providerKey: DiscoveryProviderKey; env?: NodeJS.ProcessEnv; transport?: HttpTransport; limit?: number },
): Promise<CreatorFollowResolutionReport> {
  const env = input.env ?? process.env;
  const provider = input.providerKey;
  const empty = { resolved: 0, notFound: 0, blocked: 0, requests: 0 };
  if (resolveProviderMode(provider, env) !== "live" || !providerCredentialStatus(provider, env).present) {
    return { status: "skipped", ...empty, reason: "not_live_or_credentialed" };
  }
  const pending = await withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, provider);
    if (!runtime?.enabled || runtime.paused || runtime.mode !== "live" || (runtime.retryAfterAt && runtime.retryAfterAt > new Date())) return null;
    return rowsOf<{ id: string; input_handle: string }>(
      await tx.execute(sql`SELECT id, input_handle FROM app.list_pending_creator_follows(${provider}, ${Math.max(1, Math.min(input.limit ?? 3, 5))})`),
    );
  });
  if (!pending) return { status: "skipped", ...empty, reason: "paused_or_disabled" };
  if (pending.length === 0) return { status: "skipped", ...empty, reason: "no_pending_follows" };
  const budget = budgetedDiscoveryTransport(db, provider, env, input.transport);
  const report = { ...empty };
  for (const request of pending) {
    let found: { external_account_id: string; display_name: string; handle: string | null } | null;
    try {
      found =
        provider === "youtube"
          ? await createLiveYoutubeProvider(env, budget.transport)!.resolveChannel(request.input_handle)
          : await (async () => {
              const user = await createLiveRedditProvider(env, budget.transport)!.getUser(request.input_handle);
              return user ? { ...user, handle: `u/${user.external_account_id}` } : null;
            })();
    } catch (error) {
      if (error instanceof DiscoveryBudgetError) {
        report.requests = budget.requestCount();
        return { status: "skipped", ...report, reason: "budget_exhausted" };
      }
      const errorClass = error instanceof ProviderHttpError ? error.errorClass : "lookup_failed";
      const terminal = errorClass === "invalid_account";
      await withPlatformContext(db, (tx) =>
        tx.execute(sql`SELECT app.complete_creator_follow(${request.id}, ${terminal ? "not_found" : "failed"}, NULL, NULL, ${errorClass})`),
      );
      if (terminal) report.notFound += 1;
      continue;
    }
    if (!found) {
      await withPlatformContext(db, (tx) =>
        tx.execute(sql`SELECT app.complete_creator_follow(${request.id}, 'not_found', NULL, NULL, 'not_found')`),
      );
      report.notFound += 1;
      continue;
    }
    const account = found;
    const outcome = await withPlatformContext(db, async (tx) => {
      const accountId = stableSourceId("sac", [provider, account.external_account_id]);
      const now = new Date();
      await tx
        .insert(sourceAccount)
        .values({
          id: accountId,
          sourceType: provider,
          externalAccountId: account.external_account_id,
          handle: account.handle,
          displayName: account.display_name,
          canonicalUrl:
            provider === "youtube"
              ? `https://www.youtube.com/channel/${account.external_account_id}`
              : `https://www.reddit.com/user/${account.external_account_id}`,
          metadata: { added_by: "workspace_follow" },
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();
      const [stored] = await tx
        .select({ id: sourceAccount.id })
        .from(sourceAccount)
        .where(and(eq(sourceAccount.sourceType, provider), eq(sourceAccount.externalAccountId, account.external_account_id)))
        .limit(1);
      const linked = await ensureCreatorForSourceAccount(tx, stored!.id);
      const state = await ensureFollowedMonitored(tx, {
        providerKey: provider,
        creatorId: linked.creator.id,
        sourceAccountId: stored!.id,
        externalAccountId: account.external_account_id,
        displayName: account.display_name,
      });
      await tx.execute(
        state === "blocked"
          ? sql`SELECT app.complete_creator_follow(${request.id}, 'blocked', NULL, ${account.external_account_id}, 'excluded_by_operator')`
          : sql`SELECT app.complete_creator_follow(${request.id}, 'resolved', ${linked.creator.id}, ${account.external_account_id}, NULL)`,
      );
      return state;
    });
    if (outcome === "blocked") report.blocked += 1;
    else report.resolved += 1;
  }
  report.requests = budget.requestCount();
  return { status: "completed", ...report };
}
