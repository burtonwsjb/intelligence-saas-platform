import { isHostedRuntime } from "@isp/shared";
import { createHash, randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount } from "../creator/ingest.js";
import { latestTrustState } from "../creator/authority.js";
import {
  DISCOVERY_RELEVANCE_STATES,
  discoveredCreator,
  discoveryRun,
  discoveryTopic,
  type DiscoveryProviderKey,
  type DiscoveryRelevanceState,
} from "../schema/discovery.js";
import { receiveSourceContentRecord } from "../source/ingest.js";
import { sourceAccount } from "../schema/source.js";
import { stableSourceId, type SourceContentRecordInput } from "../source/identity.js";
import { sourceIntelligenceFixtures } from "../source/fixtures.js";
import { FixtureRedditSourceProvider, FixtureYoutubeSourceProvider } from "../source/provider.js";
import { createLiveRedditProvider, createLiveYoutubeProvider } from "./live-social.js";
import { ProviderHttpError, type HttpTransport } from "./transport.js";
import { withPlatformContext } from "../rls.js";
import { providerCredentialStatus, resolveProviderMode } from "./catalog.js";
import { getProviderRuntime } from "./runtime.js";
import { budgetedDiscoveryTransport, DiscoveryBudgetError } from "./discovery-budget.js";
import { enqueuePlatformJob, PLATFORM_JOB_VERSION, platformJobCreatedAt } from "./outbox.js";
import { insertBreakGlassAudit } from "../platform/audit.js";

export const DISCOVERY_VERSION = "discovery.v2";
export const DISCOVERY_MAX_RESULTS = 10;
export const DISCOVERY_QUOTA_BUDGET = 200;
// Legacy exported estimate is not used for enforcement. Request buckets are the
// operational limit; Google quotas must also be checked in the provider console.
export const YOUTUBE_SEARCH_QUOTA_UNITS = 100;
export class DiscoveryConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "DiscoveryConfigurationError"; }
}
export function normalizeDiscoveryQuery(query: string): string {
  const value = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (value.length < 3 || value.length > 120 || [...query].some((char) => char.charCodeAt(0) < 32) || /AIza[\w-]+|[?&](?:key|token)=/i.test(value)) {
    throw new DiscoveryConfigurationError("Discovery query must be 3-120 characters and contain no credentials.");
  }
  return value;
}

export const DEFAULT_DISCOVERY_STRATEGIES = [
  { strategyKey: "pokemon_tcg", query: "Pokemon TCG" },
  { strategyKey: "pokemon_cards", query: "Pokemon cards" },
  { strategyKey: "pokemon_investing", query: "Pokemon TCG investing" },
  { strategyKey: "pokemon_market", query: "Pokemon market" },
  { strategyKey: "pokemon_prices", query: "Pokemon card prices" },
  { strategyKey: "pokemon_grading", query: "Pokemon grading" },
  { strategyKey: "pokemon_restock", query: "Pokemon restock" },
  { strategyKey: "pokemon_new_set", query: "Pokemon new set" },
  { strategyKey: "anomaly", query: "Pokemon card spike" },
] as const;

const INVESTING_LANGUAGE = /invest|price|grade|psa|cgc|restock|market|sold|buy|hold|sell|undervalue|overpay/i;
const TCG_LANGUAGE = /pokemon|pokémon|tcg|trading card|booster| illustrator|alt art/i;

function stableDiscoveryId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}

export function isDiscoveryProviderKey(value: string): value is DiscoveryProviderKey {
  return value === "youtube" || value === "reddit";
}

export function isDiscoveryRelevanceState(value: string): value is DiscoveryRelevanceState {
  return (DISCOVERY_RELEVANCE_STATES as readonly string[]).includes(value);
}

export function calculateCreatorRelevance(input: {
  query: string;
  title?: string | null;
  summary?: string | null;
  topicHits?: number;
  views?: number | null;
}): { score: number; state: Exclude<DiscoveryRelevanceState, "excluded"> } {
  const hay = `${input.title ?? ""} ${input.summary ?? ""}`.toLowerCase();
  const tokens = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2);
  const tokenHits = tokens.filter((token) => hay.includes(token)).length;
  const tokenScore = tokens.length ? Math.min(0.5, (tokenHits / tokens.length) * 0.5) : 0;
  const tcgScore = TCG_LANGUAGE.test(hay) ? 0.2 : 0;
  const investingScore = INVESTING_LANGUAGE.test(hay) ? 0.2 : 0;
  const hitScore = Math.min(0.2, Math.max(0, (input.topicHits ?? 1) - 1) * 0.1);
  const reachScore = input.views && input.views >= 10_000 ? 0.1 : 0;
  const score = Number(Math.min(1, tokenScore + tcgScore + investingScore + hitScore + reachScore).toFixed(4));
  if (score >= 0.5) {
    return { score, state: "monitored" };
  }
  if (score < 0.25) {
    return { score, state: "low_confidence" };
  }
  return { score, state: "candidate" };
}

export async function ensureDiscoveryTopics(db: Database): Promise<number> {
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1769172993, 2)`);
    return bootstrapDiscoveryTopics(tx);
  });
}

async function bootstrapDiscoveryTopics(db: Database): Promise<number> {
  let inserted = 0;
  for (const providerKey of ["youtube", "reddit"] as const) {
    for (const [index, strategy] of DEFAULT_DISCOVERY_STRATEGIES.entries()) {
      const id = stableDiscoveryId("dtp", [providerKey, strategy.query]);
      const result = await db
        .insert(discoveryTopic)
        .values({
          id,
          providerKey,
          query: strategy.query,
          strategyKey: strategy.strategyKey,
          priority: 10 + index,
        })
        .onConflictDoNothing()
        .returning({ id: discoveryTopic.id });
      inserted += result.length;
    }
  }
  // Derive a small candidate set from the actual catalog and recent scores,
  // rather than labeling a fixed 2024 set as the forever-current set.
  const derived = await db.execute(sql`
    SELECT query, origin_id, strategy FROM (
      (SELECT 'Pokemon ' || name AS query, id AS origin_id, 'derived_set' AS strategy
       FROM tcg_set WHERE game_key='pokemon' AND status='active'
       ORDER BY release_date DESC NULLS LAST, id LIMIT 3)
      UNION ALL
      (SELECT 'Pokemon ' || c.canonical_name || ' market' AS query, c.id AS origin_id, 'derived_opportunity' AS strategy
       FROM tcg_score_snapshot s JOIN tcg_printing p ON p.id=s.printing_id
       JOIN tcg_card_concept c ON c.id=p.card_id
       WHERE p.game_key='pokemon' AND p.status='active' AND c.status='active'
         AND s.as_of <= now() AND s.as_of >= now()-interval '30 days'
       ORDER BY s.opportunity_score DESC, s.as_of DESC, s.id LIMIT 3)
    ) candidates`);
  const candidates = (Array.isArray(derived) ? derived : (derived as unknown as { rows: unknown[] }).rows) as { query: string; origin_id: string; strategy: string }[];
  for (const providerKey of ["youtube", "reddit"] as const) {
    // Limit active automatically derived topics. Pausing them frees capacity;
    // a paused topic is never re-enabled by a subsequent bootstrap.
    const existing = await db.select({ id: discoveryTopic.id }).from(discoveryTopic)
      .where(sql`${discoveryTopic.providerKey}=${providerKey} AND ${discoveryTopic.enabled}=true AND ${discoveryTopic.strategyKey} IN ('derived_set','derived_opportunity')`).limit(20);
    let available = Math.max(0, 20 - existing.length);
    for (const candidate of candidates) {
      if (!available) break;
      let query: string;
      try { query = normalizeDiscoveryQuery(candidate.query); } catch { continue; }
      const result = await db.insert(discoveryTopic).values({
        id: stableDiscoveryId("dtp", [providerKey, query]), providerKey, query,
        strategyKey: candidate.strategy, priority: 30,
        metadata: { origin_id: candidate.origin_id, created_source: "automatic_catalog" },
      }).onConflictDoNothing().returning({ id: discoveryTopic.id });
      inserted += result.length;
      available -= result.length;
    }
  }
  return inserted;
}

export async function listDiscoveryRuns(db: Database) {
  return db.select().from(discoveryRun).orderBy(desc(discoveryRun.startedAt), discoveryRun.id).limit(30);
}

export async function listDiscoveryTopics(db: Database, providerKey?: DiscoveryProviderKey) {
  if (providerKey) {
    return db.select().from(discoveryTopic).where(eq(discoveryTopic.providerKey, providerKey)).limit(200);
  }
  return db.select().from(discoveryTopic).limit(200);
}

export async function listDiscoveredCreators(db: Database, state?: DiscoveryRelevanceState) {
  if (state) {
    return db.select().from(discoveredCreator).where(eq(discoveredCreator.relevanceState, state)).limit(200);
  }
  return db.select().from(discoveredCreator).limit(200);
}

export async function setDiscoveryTopicEnabled(
  db: Database,
  input: { topicId: string; enabled: boolean },
) {
  await db
    .update(discoveryTopic)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(discoveryTopic.id, input.topicId));
  const [row] = await db.select().from(discoveryTopic).where(eq(discoveryTopic.id, input.topicId)).limit(1);
  return row ?? null;
}

export async function setDiscoveredCreatorState(
  db: Database,
  input: { id: string; relevanceState: DiscoveryRelevanceState },
) {
  if (!isDiscoveryRelevanceState(input.relevanceState)) {
    throw new Error("Unknown discovery relevance state.");
  }
  const [row] = await db.select().from(discoveredCreator).where(eq(discoveredCreator.id, input.id)).limit(1);
  if (!row) throw new DiscoveryConfigurationError("Discovered creator does not exist.");
  const [updated] = await db.update(discoveredCreator).set({ relevanceState: input.relevanceState,
    discoveryProvenance: { ...row.discoveryProvenance, operator_state: input.relevanceState, operator_state_at: new Date().toISOString() },
  }).where(eq(discoveredCreator.id, input.id)).returning();
  return updated ?? null;
}

export async function nextDiscoveryTopic(db: Database, providerKey: DiscoveryProviderKey) {
  const [row] = await db
    .select()
    .from(discoveryTopic)
    .where(sql`${discoveryTopic.providerKey} = ${providerKey} AND ${discoveryTopic.enabled} = true`)
    .orderBy(sql`${discoveryTopic.lastRunAt} NULLS FIRST`, asc(discoveryTopic.priority))
    .limit(1);
  return row ?? null;
}

async function collectDiscoveryRecords(input: {
  providerKey: DiscoveryProviderKey;
  query: string;
  limit: number;
  env: NodeJS.ProcessEnv;
  transport?: HttpTransport;
  records?: SourceContentRecordInput[];
}): Promise<SourceContentRecordInput[]> {
  if (input.records) {
    return input.records.slice(0, input.limit);
  }
  if (input.providerKey === "youtube") {
    const live = createLiveYoutubeProvider(input.env, input.transport);
    if (live) {
      return live.searchContent({ q: input.query, limit: input.limit });
    }
    return new FixtureYoutubeSourceProvider(sourceIntelligenceFixtures()).searchContent({
      q: input.query,
      limit: input.limit,
    });
  }
  const live = createLiveRedditProvider(input.env, input.transport);
  if (live) {
    return live.searchPosts({ q: input.query, limit: input.limit });
  }
  return new FixtureRedditSourceProvider(sourceIntelligenceFixtures()).searchPosts({
    q: input.query,
    limit: input.limit,
  });
}

function subscriberCount(record: SourceContentRecordInput): number | null {
  const raw = record.account.metadata?.subscriber_count;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function redditCommunityNames(records: SourceContentRecordInput[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    const raw = record.content.metadata?.subreddit ?? record.account.metadata?.subreddit;
    const fromUrl = record.content.canonical_url?.match(/\/r\/([^/]+)/i)?.[1];
    const name = (typeof raw === "string" && raw.trim() ? raw : fromUrl) ?? "";
    if (name) {
      names.add(name.replace(/^r\//, "").trim());
    }
  }
  return [...names].slice(0, 10);
}

export async function persistDiscoveredCommunities(
  db: Database,
  input: { query: string; names: string[] },
) {
  let inserted = 0;
  for (const name of input.names) {
    if (!name) {
      continue;
    }
    const accountId = stableSourceId("sac", ["reddit", `community:${name}`]);
    const now = new Date();
    const result = await db
      .insert(sourceAccount)
      .values({
        id: accountId,
        sourceType: "reddit",
        externalAccountId: `r/${name}`,
        handle: `r/${name}`,
        displayName: name,
        canonicalUrl: `https://www.reddit.com/r/${name}`,
        metadata: { kind: "community", discovery_query: input.query, discovery_version: DISCOVERY_VERSION },
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: sourceAccount.id });
    inserted += result.length;
  }
  return inserted;
}

function dedupeRecords(records: SourceContentRecordInput[]): SourceContentRecordInput[] {
  const videos = new Set<string>();
  const unique: SourceContentRecordInput[] = [];
  for (const record of records) {
    const key = `${record.provider}:${record.content.external_content_id}`;
    if (videos.has(key)) {
      continue;
    }
    videos.add(key);
    unique.push(record);
  }
  return unique;
}

export type SocialDiscoveryReport = {
  provider_key: DiscoveryProviderKey;
  query: string;
  topic_id: string | null;
  videos_seen: number;
  channels_seen: number;
  creators_linked: number;
  content_ingested: number;
  /** Legacy field; since discovery.v2 this is HTTP requests, not vendor quota units. */
  quota_units: number;
  status: "completed" | "failed" | "skipped";
  discovered_creator_ids: string[];
  reason?: string | null;
};

export async function persistDiscoveryFromRecords(
  db: Database,
  input: {
    providerKey: DiscoveryProviderKey;
    query: string;
    topicId?: string | null;
    trigger: "schedule" | "admin" | "staging";
    records: SourceContentRecordInput[];
    ingestContent?: boolean;
    runId?: string;
    requestCount?: number;
  },
): Promise<SocialDiscoveryReport> {
  const records = dedupeRecords(input.records);
  const channels = new Map<string, SourceContentRecordInput>();
  for (const record of records) {
    channels.set(record.account.external_account_id, record);
  }
  const runId = input.runId ?? `drn_${randomUUID()}`;
  if (!input.runId) await db.insert(discoveryRun).values({
    id: runId,
    topicId: input.topicId ?? null,
    providerKey: input.providerKey,
    query: input.query,
    trigger: input.trigger,
    status: "started",
    videosSeen: records.length,
    channelsSeen: channels.size,
    quotaUnits: input.requestCount ?? 0,
    metadata: { version: DISCOVERY_VERSION, channel_ids_required: false },
  });

  let creatorsLinked = 0;
  let contentIngested = 0;
  const discoveredIds: string[] = [];

  for (const record of records) {
    if (input.ingestContent !== false) {
      await receiveSourceContentRecord(db, record);
      contentIngested += 1;
    }
  }

  for (const record of channels.values()) {
    const accountId = stableSourceId("sac", [record.provider, record.account.external_account_id]);
    const now = new Date();
    await db
      .insert(sourceAccount)
      .values({
        id: accountId,
        sourceType: record.provider,
        externalAccountId: record.account.external_account_id,
        handle: record.account.handle ?? null,
        displayName: record.account.display_name ?? null,
        canonicalUrl: record.account.canonical_url ?? null,
        metadata: { discovery_version: DISCOVERY_VERSION },
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing();
    // A database failure must roll back this persistence transaction, rather
    // than being swallowed and followed by writes in an aborted transaction.
    const linked = await ensureCreatorForSourceAccount(db, accountId);
    creatorsLinked += 1;
    const existing = await db
      .select()
      .from(discoveredCreator)
      .where(
        sql`${discoveredCreator.providerKey} = ${input.providerKey} AND ${discoveredCreator.externalAccountId} = ${record.account.external_account_id}`,
      )
      .limit(1);
    const topicKey = normalizeDiscoveryQuery(input.query).toLowerCase();
    await db.execute(sql`INSERT INTO discovery_creator_topic (creator_id,provider_key,topic_key)
      VALUES (${linked.creator.id},${input.providerKey},${topicKey}) ON CONFLICT DO NOTHING`);
    const hitResult = await db.execute(sql`SELECT count(*)::int AS count FROM discovery_creator_topic
      WHERE creator_id=${linked.creator.id} AND provider_key=${input.providerKey}`);
    const hitRows = Array.isArray(hitResult) ? hitResult : (hitResult as unknown as { rows: { count: number }[] }).rows;
    const topicHits = Number((hitRows[0] as { count: number } | undefined)?.count ?? 1);
    const relevance = calculateCreatorRelevance({
      query: input.query,
      title: record.content.title,
      summary: record.content.summary,
      topicHits,
      views: record.engagement?.views ?? null,
    });
    const operatorState = existing[0]?.discoveryProvenance.operator_state;
    const nextState =
      existing[0]?.relevanceState === "excluded" || (await latestTrustState(db, linked.creator.id)) === "excluded" ? "excluded"
        : typeof operatorState === "string" && isDiscoveryRelevanceState(operatorState) ? operatorState : relevance.state;
    const id =
      existing[0]?.id ??
      stableDiscoveryId("dcr", [input.providerKey, record.account.external_account_id]);
    if (existing[0]) {
      await db
        .update(discoveredCreator)
        .set({
          displayName: record.account.display_name ?? existing[0].displayName,
          lastTopicId: input.topicId ?? existing[0].lastTopicId,
          topicHits,
          relevanceScore: String(relevance.score),
          relevanceState: nextState,
          reachViews: record.engagement?.views ?? existing[0].reachViews,
          reachSubscribers: subscriberCount(record) ?? existing[0].reachSubscribers,
          lastDiscoveredAt: new Date(),
          discoveryProvenance: {
            ...existing[0].discoveryProvenance,
            version: DISCOVERY_VERSION,
            last_query: input.query,
            last_content_id: record.content.external_content_id,
          },
        })
        .where(eq(discoveredCreator.id, existing[0].id));
      discoveredIds.push(existing[0].id);
    } else {
      await db.insert(discoveredCreator).values({
        id,
        creatorId: linked.creator.id,
        sourceAccountId: linked.link.sourceAccountId,
        providerKey: input.providerKey,
        externalAccountId: record.account.external_account_id,
        displayName: record.account.display_name ?? record.account.handle,
        firstTopicId: input.topicId ?? null,
        lastTopicId: input.topicId ?? null,
        topicHits,
        relevanceScore: String(relevance.score),
        relevanceState: nextState,
        reachViews: record.engagement?.views ?? null,
        reachSubscribers: subscriberCount(record),
        discoveryProvenance: {
          version: DISCOVERY_VERSION,
          first_query: input.query,
          first_content_id: record.content.external_content_id,
        },
      });
      discoveredIds.push(id);
    }
  }

  if (input.providerKey === "reddit") {
    await persistDiscoveredCommunities(db, {
      query: input.query,
      names: redditCommunityNames(records),
    });
  }

  if (input.topicId) {
    await db
      .update(discoveryTopic)
      .set({ lastRunAt: new Date(), lastErrorClass: null, updatedAt: new Date() })
      .where(eq(discoveryTopic.id, input.topicId));
  }

  await db
    .update(discoveryRun)
    .set({
      status: "completed",
      videosSeen: records.length,
      channelsSeen: channels.size,
      quotaUnits: input.requestCount ?? 0,
      creatorsLinked,
      contentIngested,
      completedAt: new Date(),
    })
    .where(eq(discoveryRun.id, runId));

  return {
    provider_key: input.providerKey,
    query: input.query,
    topic_id: input.topicId ?? null,
    videos_seen: records.length,
    channels_seen: channels.size,
    creators_linked: creatorsLinked,
    content_ingested: contentIngested,
    quota_units: input.requestCount ?? 0,
    status: "completed",
    discovered_creator_ids: discoveredIds,
  };
}

export async function runSocialDiscovery(
  db: Database,
  input: {
    providerKey: DiscoveryProviderKey; query?: string; limit?: number;
    trigger?: "schedule" | "admin" | "staging"; env?: NodeJS.ProcessEnv;
    transport?: HttpTransport; records?: SourceContentRecordInput[]; ingestContent?: boolean;
  },
): Promise<SocialDiscoveryReport> {
  const env = input.env ?? process.env;
  if (!isDiscoveryProviderKey(input.providerKey)) throw new DiscoveryConfigurationError("Unknown discovery provider.");
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > DISCOVERY_MAX_RESULTS)) {
    throw new DiscoveryConfigurationError("Discovery limit must be an integer from 1 to 10.");
  }
  const limit = input.limit ?? DISCOVERY_MAX_RESULTS;
  const hosted = isHostedRuntime(env);
  const mode = resolveProviderMode(input.providerKey, env);
  if (hosted && (input.records || mode === "fixture")) throw new DiscoveryConfigurationError("Fixture discovery is forbidden in hosted environments.");
  if (mode === "disabled") throw new DiscoveryConfigurationError("Discovery provider is disabled; credentials alone do not activate it.");
  if (mode === "live" && !providerCredentialStatus(input.providerKey, env).present) {
    throw new DiscoveryConfigurationError("Live discovery credentials are missing. Fixture fallback is forbidden.");
  }
  const runtime = await withPlatformContext(db, (tx) => getProviderRuntime(tx, input.providerKey));
  if ((runtime?.paused || (hosted && (!runtime?.enabled || runtime.mode !== "live")))) {
    throw new DiscoveryConfigurationError("Discovery is paused or not enabled by the operator.");
  }
  const requestedQuery = input.query ? normalizeDiscoveryQuery(input.query) : null;
  const topic = await withPlatformContext(db, async (tx) => {
    await ensureDiscoveryTopics(tx);
    if (!requestedQuery) return nextDiscoveryTopic(tx, input.providerKey);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1769172993, 2)`);
    const [existing] = await tx.select().from(discoveryTopic)
      .where(sql`${discoveryTopic.providerKey}=${input.providerKey} AND lower(${discoveryTopic.query})=lower(${requestedQuery})`)
      .orderBy(discoveryTopic.enabled, discoveryTopic.createdAt, discoveryTopic.id).limit(1);
    if (existing) return existing;
    const id = stableDiscoveryId("dtp", [input.providerKey, requestedQuery.toLowerCase()]);
    await tx.insert(discoveryTopic).values({ id, providerKey: input.providerKey, query: requestedQuery, strategyKey: "ad_hoc", priority: 50 }).onConflictDoNothing();
    const [row] = await tx.select().from(discoveryTopic).where(eq(discoveryTopic.id, id)).limit(1);
    return row ?? null;
  });
  if (!topic?.enabled) throw new DiscoveryConfigurationError("No enabled discovery topic is available.");
  const runId = `drn_${randomUUID()}`;
  await withPlatformContext(db, (tx) => tx.insert(discoveryRun).values({
    id: runId, topicId: topic.id, providerKey: input.providerKey, query: topic.query,
    trigger: input.trigger ?? "schedule", status: "started", metadata: { version: DISCOVERY_VERSION, channel_ids_required: false },
  }));
  const budgeted = budgetedDiscoveryTransport(db, input.providerKey, env, input.transport);
  try {
    const records = await collectDiscoveryRecords({ providerKey: input.providerKey, query: topic.query,
      limit, env: mode === "fixture" ? { ...env, YOUTUBE_API_KEY: undefined, REDDIT_CLIENT_ID: undefined } : env,
      transport: mode === "live" ? budgeted.transport : input.transport, records: input.records });
    let communities: string[] = [];
    if (input.providerKey === "reddit" && mode === "live" && !input.records) {
      const live = createLiveRedditProvider(env, budgeted.transport);
      communities = (await live!.searchCommunities({ q: topic.query, limit: Math.min(5, limit) })).map((r) => r.name);
    }
    return await withPlatformContext(db, async (tx) => {
      // Serialize identity linkage across concurrent discoveries, without holding
      // a database transaction open during external HTTP requests.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1769172993, 1)`);
      if (communities.length) await persistDiscoveredCommunities(tx, { query: topic.query, names: communities });
      return persistDiscoveryFromRecords(tx, { providerKey: input.providerKey, query: topic.query, topicId: topic.id,
        trigger: input.trigger ?? "schedule", records: records.slice(0, limit), ingestContent: input.ingestContent,
        runId, requestCount: budgeted.requestCount() });
    });
  } catch (error) {
    const reason = error instanceof DiscoveryBudgetError ? "budget_exhausted" : error instanceof ProviderHttpError ? error.errorClass : "discovery_failed";
    await withPlatformContext(db, async (tx) => {
      await tx.update(discoveryRun).set({ status: "failed", errorClass: reason, quotaUnits: budgeted.requestCount(), completedAt: new Date() }).where(eq(discoveryRun.id, runId));
      await tx.update(discoveryTopic).set({ lastRunAt: new Date(), lastErrorClass: reason, updatedAt: new Date() }).where(eq(discoveryTopic.id, topic.id));
    });
    return { provider_key: input.providerKey, query: topic.query, topic_id: topic.id, videos_seen: 0,
      channels_seen: 0, creators_linked: 0, content_ingested: 0, quota_units: budgeted.requestCount(),
      status: "failed", reason, discovered_creator_ids: [] };
  }
}

/** Vercel queues intent only. Credentials and network calls stay in the worker. */
export async function requestDiscoveryRun(db: Database, input: {
  providerKey: string; query: string; actorUserId: string; confirm: boolean;
}) {
  if (!input.confirm || !isDiscoveryProviderKey(input.providerKey)) throw new DiscoveryConfigurationError("Confirmed discovery provider is required.");
  const providerKey = input.providerKey;
  const query = normalizeDiscoveryQuery(input.query);
  return withPlatformContext(db, async (tx) => {
    const runtime = await getProviderRuntime(tx, providerKey);
    if (!runtime?.enabled || runtime.paused || runtime.mode !== "live" || runtime.credentialStatus !== "present") {
      throw new DiscoveryConfigurationError("Provider must be live, enabled, unpaused, and credentialed in the worker.");
    }
    const id = stableDiscoveryId("discovery", [providerKey, query.toLowerCase(), String(Math.floor(Date.now() / 60_000))]);
    const result = await enqueuePlatformJob(tx, { id, jobType: "provider.sync.v1", payload: {
      job_version: PLATFORM_JOB_VERSION, job_type: "provider.sync.v1", job_id: id, provider_key: providerKey,
      discovery_query: query, trigger: "admin", limit: 10, created_at: platformJobCreatedAt(),
    }});
    if (result.enqueued) await insertBreakGlassAudit(tx, { actorUserId: input.actorUserId, action: "discovery.run",
      targetType: "platform_outbox", targetId: id, metadata: { provider: providerKey, limit: 10 } });
    return { jobId: id, status: "queued" as const, enqueued: result.enqueued };
  });
}
