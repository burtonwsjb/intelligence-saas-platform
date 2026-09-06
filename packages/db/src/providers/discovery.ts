import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ensureCreatorForSourceAccount } from "../creator/ingest.js";
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
import type { HttpTransport } from "./transport.js";

export const DISCOVERY_VERSION = "discovery.v1";
export const DISCOVERY_MAX_RESULTS = 10;
export const DISCOVERY_QUOTA_BUDGET = 200;
export const YOUTUBE_SEARCH_QUOTA_UNITS = 100;

export const DEFAULT_DISCOVERY_STRATEGIES = [
  { strategyKey: "pokemon_tcg", query: "Pokemon TCG" },
  { strategyKey: "pokemon_cards", query: "Pokemon cards" },
  { strategyKey: "pokemon_investing", query: "Pokemon TCG investing" },
  { strategyKey: "pokemon_market", query: "Pokemon market" },
  { strategyKey: "pokemon_prices", query: "Pokemon card prices" },
  { strategyKey: "pokemon_grading", query: "Pokemon grading" },
  { strategyKey: "pokemon_restock", query: "Pokemon restock" },
  { strategyKey: "pokemon_new_set", query: "Pokemon new set" },
  { strategyKey: "active_set", query: "Pokemon Twilight Masquerade" },
  { strategyKey: "high_opportunity", query: "Greninja TCG" },
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
  const score = Number((tokenScore + tcgScore + investingScore + hitScore + reachScore).toFixed(4));
  if (score >= 0.5) {
    return { score, state: "monitored" };
  }
  if (score < 0.25) {
    return { score, state: "low_confidence" };
  }
  return { score, state: "candidate" };
}

export async function ensureDiscoveryTopics(db: Database): Promise<number> {
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
  return inserted;
}

export async function listDiscoveryTopics(db: Database, providerKey?: DiscoveryProviderKey) {
  if (providerKey) {
    return db.select().from(discoveryTopic).where(eq(discoveryTopic.providerKey, providerKey));
  }
  return db.select().from(discoveryTopic);
}

export async function listDiscoveredCreators(db: Database, state?: DiscoveryRelevanceState) {
  if (state) {
    return db.select().from(discoveredCreator).where(eq(discoveredCreator.relevanceState, state));
  }
  return db.select().from(discoveredCreator);
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
  await db
    .update(discoveredCreator)
    .set({ relevanceState: input.relevanceState, lastDiscoveredAt: new Date() })
    .where(eq(discoveredCreator.id, input.id));
  const [row] = await db.select().from(discoveredCreator).where(eq(discoveredCreator.id, input.id)).limit(1);
  return row ?? null;
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
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
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
  quota_units: number;
  status: "completed" | "failed" | "skipped";
  discovered_creator_ids: string[];
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
  },
): Promise<SocialDiscoveryReport> {
  const records = dedupeRecords(input.records);
  const channels = new Map<string, SourceContentRecordInput>();
  for (const record of records) {
    channels.set(record.account.external_account_id, record);
  }
  const runId = stableDiscoveryId("drn", [input.providerKey, input.query, String(Date.now()), String(records.length)]);
  await db.insert(discoveryRun).values({
    id: runId,
    topicId: input.topicId ?? null,
    providerKey: input.providerKey,
    query: input.query,
    trigger: input.trigger,
    status: "started",
    videosSeen: records.length,
    channelsSeen: channels.size,
    quotaUnits: input.providerKey === "youtube" ? YOUTUBE_SEARCH_QUOTA_UNITS + records.length : records.length,
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
    let linked: Awaited<ReturnType<typeof ensureCreatorForSourceAccount>> | null = null;
    try {
      linked = await ensureCreatorForSourceAccount(db, accountId);
    } catch (error) {
      await db
        .update(discoveryRun)
        .set({
          errorClass: error instanceof Error ? error.name : "creator_link_failed",
          metadata: { version: DISCOVERY_VERSION, channel_ids_required: false, creator_link_failed: true },
        })
        .where(eq(discoveryRun.id, runId));
      continue;
    }
    if (!linked) {
      continue;
    }
    creatorsLinked += 1;
    const existing = await db
      .select()
      .from(discoveredCreator)
      .where(
        sql`${discoveredCreator.providerKey} = ${input.providerKey} AND ${discoveredCreator.externalAccountId} = ${record.account.external_account_id}`,
      )
      .limit(1);
    const topicHits = (existing[0]?.topicHits ?? 0) + 1;
    const relevance = calculateCreatorRelevance({
      query: input.query,
      title: record.content.title,
      summary: record.content.summary,
      topicHits,
      views: record.engagement?.views ?? null,
    });
    const nextState =
      existing[0]?.relevanceState === "excluded" ? "excluded" : relevance.state;
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
    quota_units: input.providerKey === "youtube" ? YOUTUBE_SEARCH_QUOTA_UNITS + records.length : records.length,
    status: "completed",
    discovered_creator_ids: discoveredIds,
  };
}

export async function runSocialDiscovery(
  db: Database,
  input: {
    providerKey: DiscoveryProviderKey;
    query?: string;
    limit?: number;
    trigger?: "schedule" | "admin" | "staging";
    env?: NodeJS.ProcessEnv;
    transport?: HttpTransport;
    records?: SourceContentRecordInput[];
    ingestContent?: boolean;
  },
): Promise<SocialDiscoveryReport> {
  await ensureDiscoveryTopics(db);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), DISCOVERY_MAX_RESULTS);
  const env = input.env ?? process.env;
  let topicId: string | null = null;
  let query = input.query?.trim() ?? "";
  if (!query) {
    const topic = await nextDiscoveryTopic(db, input.providerKey);
    query = topic?.query ?? DEFAULT_DISCOVERY_STRATEGIES[0].query;
    topicId = topic?.id ?? null;
  } else {
    const id = stableDiscoveryId("dtp", [input.providerKey, query]);
    await db
      .insert(discoveryTopic)
      .values({
        id,
        providerKey: input.providerKey,
        query,
        strategyKey: "ad_hoc",
        priority: 50,
      })
      .onConflictDoNothing();
    topicId = id;
  }
  const quota =
    input.providerKey === "youtube" ? YOUTUBE_SEARCH_QUOTA_UNITS + limit : limit;
  if (quota > DISCOVERY_QUOTA_BUDGET) {
    return {
      provider_key: input.providerKey,
      query,
      topic_id: topicId,
      videos_seen: 0,
      channels_seen: 0,
      creators_linked: 0,
      content_ingested: 0,
      quota_units: quota,
      status: "skipped",
      discovered_creator_ids: [],
    };
  }
  const records = await collectDiscoveryRecords({
    providerKey: input.providerKey,
    query,
    limit,
    env,
    transport: input.transport,
    records: input.records,
  });
  if (input.providerKey === "reddit" && !input.records) {
    const live = createLiveRedditProvider(env, input.transport);
    if (live) {
      const communities = await live.searchCommunities({ q: query, limit: Math.min(5, limit) });
      await persistDiscoveredCommunities(db, {
        query,
        names: communities.map((row) => row.name),
      });
    }
  }
  return persistDiscoveryFromRecords(db, {
    providerKey: input.providerKey,
    query,
    topicId,
    trigger: input.trigger ?? "schedule",
    records,
    ingestContent: input.ingestContent,
  });
}
