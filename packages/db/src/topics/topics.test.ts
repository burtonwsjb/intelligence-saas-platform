import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import {
  TENANT_TOPIC_MAX,
  TopicInputError,
  addTenantTopic,
  getTopicSentiment,
  listTenantTopics,
  removeTenantTopic,
  setTenantTopicStatus,
  syncWorkspaceTopics,
  topicTokens,
} from "./topics.js";

const NOW = new Date("2026-10-01T00:00:00Z");

describe("topic words", () => {
  it("keeps meaningful words and folds simple plurals", () => {
    expect(topicTokens("Bitcoin")).toEqual(["bitcoin"]);
    expect(topicTokens("Pokemon card prices")).toEqual(["pokemon", "card", "price"]);
    expect(topicTokens("the and of")).toEqual([]);
  });
});

describe("workspace topics", () => {
  let client: PGlite;
  let db: Database;
  const org = "org_topic_a";
  const user = "user_topic_a";

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await client.exec(`
      INSERT INTO "user" (id, name, email) VALUES ('${user}', 'A', 'topics@example.test');
      INSERT INTO organization (id, name, slug) VALUES ('${org}', 'A', 'topics-a');
    `);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("adds, dedupes and limits a workspace's topics", async () => {
    const first = await addTenantTopic(db, { organizationId: org, userId: user, query: "  Bitcoin  " });
    expect(first.created).toBe(true);
    expect((await addTenantTopic(db, { organizationId: org, userId: user, query: "bitcoin" })).created).toBe(false);
    await expect(addTenantTopic(db, { organizationId: org, userId: user, query: "ab" })).rejects.toThrow(TopicInputError);
    for (let index = 1; index < TENANT_TOPIC_MAX; index += 1) {
      await addTenantTopic(db, { organizationId: org, userId: user, query: `filler topic ${index}` });
    }
    await expect(addTenantTopic(db, { organizationId: org, userId: user, query: "one too many" })).rejects.toThrow(
      TopicInputError,
    );
    for (const row of await listTenantTopics(db)) {
      if (row.query.startsWith("filler")) await removeTenantTopic(db, row.id);
    }
    expect((await listTenantTopics(db)).map((row) => row.query)).toEqual(["Bitcoin"]);
  });

  it("feeds active topics into discovery and pauses only the ones it created", async () => {
    await client.exec(`
      INSERT INTO discovery_topic (id, provider_key, query, strategy_key, enabled)
      VALUES ('operator_topic', 'youtube', 'Ethereum', 'operator', false);
    `);
    await addTenantTopic(db, { organizationId: org, userId: user, query: "Ethereum" });
    const first = await syncWorkspaceTopics(db);
    expect(first.added).toBe(3); // Bitcoin on both providers, Ethereum on Reddit only.
    const operator = await client.query<{ enabled: boolean }>(`SELECT enabled FROM discovery_topic WHERE id = 'operator_topic'`);
    expect(operator.rows[0]?.enabled).toBe(false);

    const [bitcoin] = (await listTenantTopics(db)).filter((row) => row.query === "Bitcoin");
    await setTenantTopicStatus(db, { id: bitcoin!.id, status: "paused" });
    expect((await syncWorkspaceTopics(db)).paused).toBe(2);
    const paused = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM discovery_topic WHERE query = 'Bitcoin' ORDER BY provider_key`,
    );
    expect(paused.rows.map((row) => row.enabled)).toEqual([false, false]);
    await setTenantTopicStatus(db, { id: bitcoin!.id, status: "active" });
    expect((await syncWorkspaceTopics(db)).resumed).toBe(2);
  });

  it("weights topic posts by creator track record and leaves out hidden and excluded creators", async () => {
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at) VALUES
        ('sa_pro', 'youtube', 'UCpro', 'Accurate Analyst', now(), now()),
        ('sa_anon1', 'reddit', 'anon1', 'anon1', now(), now()),
        ('sa_anon2', 'reddit', 'anon2', 'anon2', now(), now()),
        ('sa_bad', 'youtube', 'UCbad', 'Excluded Shill', now(), now());
      INSERT INTO creator (id, display_name) VALUES ('cr_pro', 'Accurate Analyst'), ('cr_bad', 'Excluded Shill');
      INSERT INTO creator_source_account (id, creator_id, source_account_id) VALUES
        ('csa_pro', 'cr_pro', 'sa_pro'), ('csa_bad', 'cr_bad', 'sa_bad');
      INSERT INTO creator_trust_event (id, creator_id, trust_state, reason) VALUES ('te_bad', 'cr_bad', 'excluded', 'test');
      INSERT INTO creator_authority_slice (id, creator_id, language_code, price_tier, sample_size, successes,
        authority_weight, trust_state, formula_version, benchmark_requirement)
      VALUES ('sl_pro', 'cr_pro', NULL, 'all', 50, 40, 0.6, 'trusted', 'authority.v1', 'test');
    `);
    const content = [
      ["c_pro", "youtube", "sa_pro", "Bitcoin is going up, buy now"],
      ["c_a1", "reddit", "sa_anon1", "Sell your bitcoin before it will drop"],
      ["c_a2", "reddit", "sa_anon2", "Bitcoin will drop, sell"],
      ["c_a3", "reddit", "sa_anon2", "bitcoin crash incoming, sell"],
      ["c_bad", "youtube", "sa_bad", "Bitcoin to the moon, buy buy buy"],
      ["c_other", "reddit", "sa_anon1", "Ethereum is undervalued, buy"],
    ];
    for (const [id, type, account, title] of content) {
      await client.query(
        `INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
         VALUES ($1, $2, $1, $3, $4, $5, 'https://example.test/' || $1, 'post', $1)`,
        [id, type, account, new Date(NOW.getTime() - 2 * 86_400_000), title],
      );
    }
    const result = await getTopicSentiment(db, "Bitcoin", "7d", { now: NOW });
    expect(result.summary.contentItems).toBe(4); // excluded creator and off-topic post left out
    expect(result.summary.counts.positive).toBe(1);
    expect(result.summary.counts.negative).toBe(3);
    // One accurate creator outweighs three accounts with no record.
    expect(result.summary.weighted.positive).toBeCloseTo(0.6);
    expect(result.summary.weighted.negative).toBeCloseTo(0.15);
    expect(result.summary.label).toBe("mostly_positive");
    expect(result.voices[0]).toMatchObject({ creatorId: "cr_pro", rated: true, leaning: "positive" });
    expect(result.buckets).toHaveLength(7);

    const hidden = await getTopicSentiment(db, "Bitcoin", "7d", { now: NOW, hiddenCreatorIds: ["cr_pro"] });
    expect(hidden.summary.contentItems).toBe(3);
    expect(hidden.summary.label).toBe("mostly_negative");
  });
});
