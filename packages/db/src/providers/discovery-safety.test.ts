import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { sourceIntelligenceFixtures } from "../source/fixtures.js";
import { runSocialDiscovery, requestDiscoveryRun, listDiscoveredCreators, normalizeDiscoveryQuery, setDiscoveredCreatorState } from "./discovery.js";
import { runStagingSourceSmoke } from "./staging.js";
import { reserveDiscoveryRequest } from "./discovery-budget.js";

describe("discovery execution safety", () => {
  let client: PGlite;
  let db: Database;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
  }, 30_000);
  afterAll(async () => { await client?.close(); });

  it("rejects fixture injection in hosted discovery", async () => {
    await expect(runSocialDiscovery(db, { providerKey: "youtube", records: [], env: { ISP_ENV: "staging", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "test-key" } })).rejects.toThrow(/Fixture discovery/);
  });
  it("never interprets credentials alone as permission for live discovery", async () => {
    const fetch = vi.fn();
    await expect(runSocialDiscovery(db, { providerKey: "youtube", env: { ISP_ENV: "staging", YOUTUBE_API_KEY: "test-key" }, transport: { fetch } })).rejects.toThrow(/disabled/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses live discovery instead of silently using fixtures when keys are absent", async () => {
    await expect(runSocialDiscovery(db, { providerKey: "youtube", env: { ISP_ENV: "staging", PROVIDER_YOUTUBE_MODE: "live" } })).rejects.toThrow(/Fixture fallback is forbidden/);
  });
  it("persists budgets across separate runs and refuses overspend", async () => {
    await reserveDiscoveryRequest(db, "reddit", "search", 2);
    await reserveDiscoveryRequest(db, "reddit", "search", 2);
    await expect(reserveDiscoveryRequest(db, "reddit", "search", 2)).rejects.toThrow(/budget exhausted/);
    const { rows } = await client.query<{ requests_used: number }>("SELECT requests_used FROM discovery_request_budget WHERE provider_key='reddit' AND bucket='search'");
    expect(rows[0]?.requests_used).toBe(2);
  });
  it("retains an HTTP reservation even when the external request fails", async () => {
    const result = await runSocialDiscovery(db, {
      providerKey: "youtube", query: "Pokemon safe failure", env: { ISP_ENV: "test", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "not-a-real-key" },
      transport: { fetch: async () => ({ status: 503, headers: {}, bodyText: '{}' }) },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("upstream_5xx");
    expect(result.quota_units).toBe(1);
    expect((await client.query<{ requests_used: number }>("SELECT requests_used FROM discovery_request_budget WHERE provider_key='youtube' AND bucket='search'")).rows[0]?.requests_used).toBe(1);
    const last = (await client.query<{ status: string; error_class: string }>("SELECT status,error_class FROM discovery_run WHERE query='Pokemon safe failure'")).rows[0];
    expect(last).toEqual({ status: "failed", error_class: "upstream_5xx" });
    expect(JSON.stringify(result)).not.toContain("not-a-real-key");
  });
  it("does not inflate topic evidence when the same creator/query is rediscovered", async () => {
    const record = sourceIntelligenceFixtures().find((row) => row.provider === "youtube")!;
    const input = { providerKey: "youtube" as const, query: "Pokemon repeated evidence", records: [record], env: { ISP_ENV: "test" } };
    const first = await runSocialDiscovery(db, input);
    expect(first.status).toBe("completed");
    const before = (await listDiscoveredCreators(db)).find((c) => c.externalAccountId === record.account.external_account_id)!;
    expect((await runSocialDiscovery(db, input)).status).toBe("completed");
    const after = (await listDiscoveredCreators(db)).find((c) => c.id === before.id)!;
    expect(after.topicHits).toBe(before.topicHits);
    expect(after.relevanceScore).toBe(before.relevanceScore);
    const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM platform_outbox WHERE job_type='source.intelligence.normalize.v1'")).rows[0]?.count;
    expect(count).toBe(1);
  });
  it("preserves manual monitoring choices and first-discovery evidence across searches", async () => {
    const record = sourceIntelligenceFixtures().find((row) => row.provider === "youtube")!;
    const [creator] = await listDiscoveredCreators(db);
    await setDiscoveredCreatorState(db, { id: creator!.id, relevanceState: "candidate" });
    const before = (await listDiscoveredCreators(db))[0]!;
    await runSocialDiscovery(db, { providerKey: "youtube", query: "Pokemon manual decision", records: [record], env: { ISP_ENV: "test" } });
    const after = (await listDiscoveredCreators(db))[0]!;
    expect(after.relevanceState).toBe("candidate");
    expect(after.discoveryProvenance.first_query).toBe(before.discoveryProvenance.first_query);
    expect(after.discoveryProvenance.operator_state).toBe("candidate");
  });
  it("does not bypass a paused topic by changing its capitalization", async () => {
    await client.exec("UPDATE discovery_topic SET enabled=false WHERE query='Pokemon cards'");
    const fetch = vi.fn();
    await expect(runSocialDiscovery(db, { providerKey: "youtube", query: "pokemon CARDS", env: { ISP_ENV: "test" }, transport: { fetch } }))
      .rejects.toThrow(/enabled discovery topic/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("queues an audited worker job without requiring credentials in the web process", async () => {
    await client.exec("INSERT INTO \"user\" (id,name,email) VALUES ('repair_operator','Operator','repair@example.invalid') ON CONFLICT DO NOTHING; UPDATE provider_runtime SET mode='live', enabled=true, paused=false, credential_status='present' WHERE provider_key='youtube';");
    const input = { providerKey: "youtube", query: "Pokemon queued test", actorUserId: "repair_operator", confirm: true };
    const first = await requestDiscoveryRun(db, input);
    const second = await requestDiscoveryRun(db, input);
    expect(first.status).toBe("queued");
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    const { rows } = await client.query<{ payload: { discovery_query: string; trigger: string; limit: number }; status: string }>("SELECT payload,status FROM platform_outbox WHERE id=$1", [first.jobId]);
    expect(rows[0]?.payload).toMatchObject({ discovery_query: input.query, trigger: "admin", limit: 10 });
    expect(rows[0]?.status).toBe("pending");
  });
  it("smoke does not reset worker controls or dispatch live jobs", async () => {
    const before = (await client.query("SELECT mode,enabled,credential_status FROM provider_runtime WHERE provider_key='youtube'")).rows;
    const pending = (await client.query("SELECT count(*)::int AS n FROM platform_outbox")).rows;
    const report = await runStagingSourceSmoke(db, { ISP_ENV: "staging" });
    expect(report.live_bounded_samples).toEqual([]);
    expect(report.queue_probe_verified).toBe(true);
    expect(report.queue_probe_enqueued).toBe(false);
    expect((await client.query("SELECT count(*)::int AS n FROM platform_outbox")).rows).toEqual(pending);
    expect((await client.query("SELECT mode,enabled,credential_status FROM provider_runtime WHERE provider_key='youtube'")).rows).toEqual(before);
  });
  it("validates query bounds and strips insignificant whitespace", () => {
    expect(normalizeDiscoveryQuery('  Pokemon  cards  ')).toBe('Pokemon cards');
    expect(() => normalizeDiscoveryQuery('x'.repeat(121))).toThrow();
    expect(() => normalizeDiscoveryQuery('secret ?key=value')).toThrow();
  });
});
