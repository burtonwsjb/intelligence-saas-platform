import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  calculateCreatorRelevance,
  ensureDiscoveryTopics,
  listDiscoveredCreators,
  listDiscoveryTopics,
  runSocialDiscovery,
  setDiscoveredCreatorState,
  setDiscoveryTopicEnabled,
} from "./discovery.js";
import { readMigrationSql, type Database } from "../index.js";
import { sourceIntelligenceFixtures } from "../source/fixtures.js";
import { tcgSet } from "../schema/tcg.js";

const disposableClients: PGlite[] = [];
afterEach(async () => { await Promise.all(disposableClients.splice(0).map((client) => client.close())); });

async function memoryDb() {
  const client = new PGlite();
  disposableClients.push(client);
  await client.exec(await readMigrationSql());
  return drizzle(client) as unknown as Database;
}

describe("automatic social discovery", () => {
  it("does not require YOUTUBE_CHANNEL_IDS and links canonical creator accounts", async () => {
    const db = await memoryDb();
    const fixtures = sourceIntelligenceFixtures().filter((row) => row.provider === "youtube");
    const report = await runSocialDiscovery(db, {
      providerKey: "youtube",
      query: "Pokemon TCG investing",
      limit: 10,
      trigger: "staging",
      env: { ISP_ENV: "test" },
      records: fixtures,
    });
    expect(report.status).toBe("completed");
    expect(report.videos_seen).toBeGreaterThan(0);
    expect(report.channels_seen).toBeGreaterThan(0);
    expect(report.creators_linked).toBeGreaterThan(0);
    expect(report.quota_units).toBeLessThanOrEqual(200);
    const creators = await listDiscoveredCreators(db);
    expect(creators.length).toBeGreaterThan(0);
    expect(creators.every((row) => row.providerKey === "youtube")).toBe(true);
    expect(creators.every((row) => row.externalAccountId.length > 0)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/AIza|YOUTUBE_API_KEY|hunter2/i);
  });

  it("dedupes videos and channels and keeps excluded creators excluded", async () => {
    const db = await memoryDb();
    const first = sourceIntelligenceFixtures().find((row) => row.provider === "youtube")!;
    const duplicate = { ...first, provider_record_id: `${first.provider_record_id}_dup` };
    const report = await runSocialDiscovery(db, {
      providerKey: "youtube",
      query: "Greninja TCG",
      records: [first, duplicate],
      trigger: "admin",
      env: { ISP_ENV: "test" },
    });
    expect(report.videos_seen).toBe(1);
    expect(report.channels_seen).toBe(1);
    const [row] = await listDiscoveredCreators(db);
    await setDiscoveredCreatorState(db, { id: row!.id, relevanceState: "excluded" });
    await runSocialDiscovery(db, {
      providerKey: "youtube",
      query: "Pokemon grading",
      records: [first],
      trigger: "admin",
      env: { ISP_ENV: "test" },
    });
    const again = await listDiscoveredCreators(db);
    expect(again[0]?.relevanceState).toBe("excluded");
    expect(again[0]?.topicHits).toBeGreaterThan(1);
  });

  it("seeds bounded topics for YouTube and Reddit without live HTTP", async () => {
    const db = await memoryDb();
    const inserted = await ensureDiscoveryTopics(db);
    expect(inserted).toBeGreaterThan(0);
    const topics = await listDiscoveryTopics(db);
    expect(topics.some((row) => row.providerKey === "youtube" && row.query === "Pokemon TCG investing")).toBe(true);
    expect(topics.some((row) => row.providerKey === "reddit" && row.query === "Pokemon market")).toBe(true);
    expect(topics.every((row) => row.query.length <= 120)).toBe(true);
  });

  it("derives topics from current catalog sets, stays bounded and preserves paused topics", async () => {
    const db = await memoryDb();
    await db.insert(tcgSet).values(Array.from({ length: 5 }, (_, i) => ({
      id: `new_set_${i}`, gameKey: "pokemon", canonicalSetKey: `new_set_${i}`,
      name: `Test Expansion ${i}`, releaseDate: `2026-0${i + 1}-01`,
    })));
    await ensureDiscoveryTopics(db);
    let topics = (await listDiscoveryTopics(db, "youtube")).filter((row) => row.strategyKey === "derived_set");
    expect(topics.map((row) => row.query).sort()).toEqual([
      "Pokemon Test Expansion 2", "Pokemon Test Expansion 3", "Pokemon Test Expansion 4",
    ]);
    const paused = topics[0]!;
    await setDiscoveryTopicEnabled(db, { topicId: paused.id, enabled: false });
    await Promise.all([ensureDiscoveryTopics(db), ensureDiscoveryTopics(db)]);
    topics = (await listDiscoveryTopics(db, "youtube")).filter((row) => row.strategyKey === "derived_set");
    expect(topics).toHaveLength(3);
    expect(topics.find((row) => row.id === paused.id)?.enabled).toBe(false);
    expect(topics.every((row) => row.metadata.created_source === "automatic_catalog")).toBe(true);
  });

  it("treats reach as reach, not authority, when scoring relevance", () => {
    const low = calculateCreatorRelevance({
      query: "cooking recipes",
      title: "My dinner vlog",
      views: 5_000_000,
    });
    expect(low.state).toBe("low_confidence");
    const high = calculateCreatorRelevance({
      query: "Pokemon TCG investing",
      title: "Pokemon TCG investing: Greninja price spike",
      summary: "Market sold comps and grading",
      topicHits: 3,
      views: 50_000,
    });
    expect(high.state).toBe("monitored");
    expect(high.score).toBeGreaterThanOrEqual(0.5);
  });

  it("discovers Reddit authors and communities from topic search without a hardcoded subreddit", async () => {
    const db = await memoryDb();
    const fixtures = sourceIntelligenceFixtures().filter((row) => row.provider === "reddit");
    const report = await runSocialDiscovery(db, {
      providerKey: "reddit",
      query: "Pokemon market",
      records: fixtures,
      trigger: "staging",
      env: { ISP_ENV: "test" },
    });
    expect(report.status).toBe("completed");
    expect(report.creators_linked).toBeGreaterThan(0);
    const creators = await listDiscoveredCreators(db);
    expect(creators.some((row) => row.providerKey === "reddit")).toBe(true);
  });

  it("does not import or call YouTube hosts from the discovery module", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./discovery.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/googleapis\.com|fetch\(/);
    expect(source).toMatch(/channel_ids_required: false/);
  });
});
