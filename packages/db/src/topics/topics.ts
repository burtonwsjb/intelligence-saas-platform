import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { withPlatformContext } from "../rls.js";
import { tenantTopic } from "../schema/topic.js";
import { discoveryTopic } from "../schema/discovery.js";
import { normalizeDiscoveryQuery, DiscoveryConfigurationError, stableDiscoveryId } from "../providers/discovery.js";
import { analyzeSourceSentiment } from "../providers/sentiment.js";
import {
  SENTIMENT_BASELINE_WEIGHT,
  SENTIMENT_KEYS,
  summarizeSentiment,
  type SentimentEvidenceRow,
  type SentimentKey,
  type SentimentSummary,
} from "../dashboard/explorer.js";

// Topics are what a workspace wants the platform to listen to: a card, a set,
// "Bitcoin", anything. Each active topic joins the global discovery rotation,
// so discovery finds the creators and posts for it under the same request
// budgets. Topic sentiment is read from the posts that mention the topic.

export const TENANT_TOPIC_MAX = 20;
export const TOPIC_WINDOWS = ["7d", "30d", "90d"] as const;
export type TopicWindow = (typeof TOPIC_WINDOWS)[number];
const TOPIC_WINDOW_DAYS: Record<TopicWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };
const TOPIC_CONTENT_LIMIT = 2000;
const WORKSPACE_STRATEGY = "workspace_topic";

export class TopicInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicInputError";
  }
}

export type TenantTopicRow = {
  id: string;
  query: string;
  status: "active" | "paused";
  createdAt: Date;
  lastSearchedAt: Date | null;
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows) as Record<string, unknown>[];
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Runs inside withOrganizationContext; RLS limits rows to the workspace. */
export async function listTenantTopics(db: Database): Promise<TenantTopicRow[]> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT t.id, t.query, t.status, t.created_at,
        (SELECT max(d.last_run_at) FROM discovery_topic d
          WHERE lower(d.query) = lower(t.query) AND d.strategy_key = ${WORKSPACE_STRATEGY}) AS last_searched_at
      FROM tenant_topic t
      ORDER BY t.created_at DESC, t.id
      LIMIT ${TENANT_TOPIC_MAX}
    `),
  );
  return rows.map((row) => ({
    id: String(row.id),
    query: String(row.query),
    status: row.status === "paused" ? "paused" : "active",
    createdAt: toDate(row.created_at),
    lastSearchedAt: row.last_searched_at == null ? null : toDate(row.last_searched_at),
  }));
}

export async function getTenantTopic(db: Database, id: string): Promise<TenantTopicRow | null> {
  return (await listTenantTopics(db)).find((row) => row.id === id) ?? null;
}

export async function addTenantTopic(db: Database, input: { organizationId: string; userId: string; query: string }) {
  let query: string;
  try {
    query = normalizeDiscoveryQuery(input.query);
  } catch (error) {
    if (error instanceof DiscoveryConfigurationError) throw new TopicInputError("Topics must be 3 to 120 characters.");
    throw error;
  }
  if (topicTokens(query).length === 0) throw new TopicInputError("Use at least one word of three or more letters.");
  const [existing] = await db
    .select({ id: tenantTopic.id, status: tenantTopic.status })
    .from(tenantTopic)
    .where(sql`lower(${tenantTopic.query}) = lower(${query})`)
    .limit(1);
  if (existing) {
    if (existing.status !== "active") {
      await db.update(tenantTopic).set({ status: "active", updatedAt: new Date() }).where(eq(tenantTopic.id, existing.id));
    }
    return { id: existing.id, created: false };
  }
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(tenantTopic);
  if (Number(count?.n ?? 0) >= TENANT_TOPIC_MAX) {
    throw new TopicInputError(`A workspace can track up to ${TENANT_TOPIC_MAX} topics. Remove one to add another.`);
  }
  const id = `tpc_${randomUUID()}`;
  await db.insert(tenantTopic).values({ id, organizationId: input.organizationId, createdByUserId: input.userId, query });
  return { id, created: true };
}

export async function setTenantTopicStatus(db: Database, input: { id: string; status: "active" | "paused" }) {
  const rows = await db
    .update(tenantTopic)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(tenantTopic.id, input.id))
    .returning({ id: tenantTopic.id });
  return rows.length > 0;
}

export async function removeTenantTopic(db: Database, id: string) {
  const rows = await db.delete(tenantTopic).where(eq(tenantTopic.id, id)).returning({ id: tenantTopic.id });
  return rows.length > 0;
}

// ---------- Worker side ----------

/**
 * Mirror active workspace topics into the global discovery rotation. New
 * topics run first (discovery picks never-run topics first). A topic nobody
 * tracks any more is paused, but only if this sync created it; an operator's
 * own settings on any topic are left alone.
 */
export async function syncWorkspaceTopics(db: Database): Promise<{ added: number; resumed: number; paused: number }> {
  return withPlatformContext(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1769172993, 3)`);
    const queries = rowsOf(await tx.execute(sql`SELECT query FROM app.list_tracked_topic_queries(100)`)).map((row) =>
      String(row.query),
    );
    const wanted = new Set(queries.map((query) => query.toLowerCase()));
    let added = 0;
    let resumed = 0;
    let paused = 0;
    for (const providerKey of ["youtube", "reddit"] as const) {
      for (const raw of queries) {
        let query: string;
        try {
          query = normalizeDiscoveryQuery(raw);
        } catch {
          continue;
        }
        const id = stableDiscoveryId("dtp", [providerKey, query]);
        const inserted = await tx
          .insert(discoveryTopic)
          .values({
            id,
            providerKey,
            query,
            strategyKey: WORKSPACE_STRATEGY,
            priority: 20,
            metadata: { created_source: "workspace" },
          })
          .onConflictDoNothing()
          .returning({ id: discoveryTopic.id });
        added += inserted.length;
        if (inserted.length === 0) {
          const result = await tx
            .update(discoveryTopic)
            .set({
              enabled: true,
              metadata: sql`${discoveryTopic.metadata} - 'workspace_inactive'`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(discoveryTopic.providerKey, providerKey),
                sql`lower(${discoveryTopic.query}) = lower(${query})`,
                eq(discoveryTopic.strategyKey, WORKSPACE_STRATEGY),
                sql`(${discoveryTopic.metadata} ->> 'workspace_inactive') = 'true'`,
              ),
            )
            .returning({ id: discoveryTopic.id });
          resumed += result.length;
        }
      }
      const ours = await tx
        .select({ id: discoveryTopic.id, query: discoveryTopic.query })
        .from(discoveryTopic)
        .where(
          and(
            eq(discoveryTopic.providerKey, providerKey),
            eq(discoveryTopic.strategyKey, WORKSPACE_STRATEGY),
            eq(discoveryTopic.enabled, true),
          ),
        )
        .limit(500);
      for (const row of ours) {
        if (wanted.has(row.query.toLowerCase())) continue;
        await tx
          .update(discoveryTopic)
          .set({
            enabled: false,
            metadata: sql`${discoveryTopic.metadata} || '{"workspace_inactive": true}'::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(discoveryTopic.id, row.id));
        paused += 1;
      }
    }
    return { added, resumed, paused };
  });
}

// ---------- Topic sentiment ----------

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "about", "are", "was", "this", "that", "its"]);

/** Words a post must contain to count as being about the topic. */
export function topicTokens(query: string): string[] {
  const words = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  // A trailing plural "s" is dropped so "prices" also matches "price".
  return [...new Set(words.map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word)))].slice(0, 6);
}

function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export type TopicPost = {
  contentId: string;
  sourceType: string;
  title: string | null;
  url: string;
  publishedAt: Date;
  accountName: string | null;
  creatorId: string | null;
  sentiment: SentimentKey | "unknown";
  weight: number;
};

export type TopicVoice = {
  accountId: string;
  creatorId: string | null;
  name: string;
  sourceType: string;
  posts: number;
  weight: number;
  rated: boolean;
  leaning: "positive" | "negative" | "neutral" | "mixed";
};

export type TopicBucket = { start: Date; positive: number; negative: number; neutral: number; mixed: number; unknown: number };

export type TopicSentiment = {
  summary: SentimentSummary;
  buckets: TopicBucket[];
  bucketDays: number;
  voices: TopicVoice[];
  recent: TopicPost[];
  tokens: string[];
  truncated: boolean;
};

/**
 * Sentiment of posts that mention every word of the topic, weighted by each
 * creator's track record exactly like card sentiment. The classifier is the
 * platform's rule-based analyzer, so it reads buy / sell / up / down language,
 * not sarcasm, and is English-first.
 */
export async function getTopicSentiment(
  db: Database,
  query: string,
  window: TopicWindow,
  options: { now?: Date; hiddenCreatorIds?: string[] } = {},
): Promise<TopicSentiment> {
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - TOPIC_WINDOW_DAYS[window] * 86_400_000);
  const tokens = topicTokens(query);
  const hidden = options.hiddenCreatorIds ?? [];
  const bucketDays = window === "7d" ? 1 : window === "30d" ? 3 : 7;
  const empty: TopicSentiment = {
    summary: summarizeSentiment([], { from, to: now }),
    buckets: [],
    bucketDays,
    voices: [],
    recent: [],
    tokens,
    truncated: false,
  };
  if (tokens.length === 0) return empty;
  const matches = sql.join(
    tokens.map((token) => sql`(sc.title ILIKE ${likePattern(token)} OR sc.summary ILIKE ${likePattern(token)})`),
    sql` AND `,
  );
  const result = rowsOf(
    await db.execute(sql`
      SELECT sc.id, sc.source_type, sc.account_id, sc.published_at, sc.title, sc.summary, sc.canonical_url,
        coalesce(sa.display_name, sa.handle) AS account_name, csa.creator_id, authority.authority_weight
      FROM source_content sc
      JOIN source_account sa ON sa.id = sc.account_id
      LEFT JOIN creator_source_account csa ON csa.source_account_id = sc.account_id
      LEFT JOIN LATERAL (
        SELECT s.authority_weight FROM creator_authority_slice s
        WHERE s.creator_id = csa.creator_id
        ORDER BY (s.language_code IS NULL AND s.price_tier = 'all') DESC, s.created_at DESC, s.id DESC
        LIMIT 1
      ) authority ON TRUE
      LEFT JOIN LATERAL (
        SELECT te.trust_state FROM creator_trust_event te
        WHERE te.creator_id = csa.creator_id
        ORDER BY te.created_at DESC LIMIT 1
      ) trust ON TRUE
      WHERE sc.published_at > ${from.toISOString()}::timestamptz
        AND sc.published_at <= ${now.toISOString()}::timestamptz
        AND ${matches}
        AND (trust.trust_state IS NULL OR trust.trust_state <> 'excluded')
        ${hidden.length ? sql`AND (csa.creator_id IS NULL OR csa.creator_id NOT IN (${sql.join(hidden.map((id) => sql`${id}`), sql`, `)}))` : sql``}
      ORDER BY sc.published_at DESC, sc.id DESC
      LIMIT ${TOPIC_CONTENT_LIMIT + 1}
    `),
  );
  const truncated = result.length > TOPIC_CONTENT_LIMIT;
  const posts: (TopicPost & { accountId: string; rated: boolean })[] = result.slice(0, TOPIC_CONTENT_LIMIT).map((row) => {
    const analysis = analyzeSourceSentiment({ text: `${row.title ?? ""} ${row.summary ?? ""}` });
    const rated = row.authority_weight != null;
    return {
      contentId: String(row.id),
      sourceType: String(row.source_type),
      title: row.title == null ? null : String(row.title),
      url: String(row.canonical_url),
      publishedAt: toDate(row.published_at),
      accountId: String(row.account_id),
      accountName: row.account_name == null ? null : String(row.account_name),
      creatorId: row.creator_id == null ? null : String(row.creator_id),
      sentiment: analysis.coarse_sentiment,
      weight: rated ? Number(row.authority_weight) : SENTIMENT_BASELINE_WEIGHT,
      rated,
    };
  });
  const evidence: SentimentEvidenceRow[] = posts.map((post) => ({
    printingId: query,
    contentId: post.contentId,
    accountId: post.accountId,
    sentiment: post.sentiment,
    weight: post.weight,
    rated: post.rated,
  }));
  const summary = summarizeSentiment(evidence, { from, to: now });

  const bucketMs = bucketDays * 86_400_000;
  const bucketCount = Math.ceil((now.getTime() - from.getTime()) / bucketMs);
  const buckets: TopicBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(from.getTime() + index * bucketMs),
    positive: 0,
    negative: 0,
    neutral: 0,
    mixed: 0,
    unknown: 0,
  }));
  for (const post of posts) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((post.publishedAt.getTime() - from.getTime()) / bucketMs)));
    buckets[index]![post.sentiment] += 1;
  }

  const byAccount = new Map<string, { voice: TopicVoice; tally: Record<SentimentKey, number> }>();
  for (const post of posts) {
    const entry =
      byAccount.get(post.accountId) ??
      {
        voice: {
          accountId: post.accountId,
          creatorId: post.creatorId,
          name: post.accountName ?? "Unnamed account",
          sourceType: post.sourceType,
          posts: 0,
          weight: post.weight,
          rated: post.rated,
          leaning: "neutral" as TopicVoice["leaning"],
        },
        tally: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
      };
    entry.voice.posts += 1;
    if (post.sentiment !== "unknown") entry.tally[post.sentiment] += 1;
    byAccount.set(post.accountId, entry);
  }
  const voices = [...byAccount.values()]
    .map(({ voice, tally }) => {
      const top = SENTIMENT_KEYS.reduce((best, key) => (tally[key] > tally[best] ? key : best), "neutral" as SentimentKey);
      return { ...voice, leaning: tally[top] > 0 ? top : ("neutral" as const) };
    })
    .sort((a, b) => b.weight * b.posts - a.weight * a.posts || b.posts - a.posts || a.name.localeCompare(b.name))
    .slice(0, 8);

  return {
    summary,
    buckets,
    bucketDays,
    voices,
    recent: posts.slice(0, 10).map(({ accountId: _accountId, rated: _rated, ...post }) => post),
    tokens,
    truncated,
  };
}
