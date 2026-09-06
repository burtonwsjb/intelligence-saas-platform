import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { sourceIntelligenceFixtures } from "../source/fixtures.js";
import { normalizeSourceIntelligenceIngest } from "../source/ingest.js";
import { runSocialDiscovery, listDiscoveredCreators } from "./discovery.js";
import { runCreatorMonitoring } from "./monitoring.js";
import type { HttpTransport, HttpResponse } from "./transport.js";

const env = { ISP_ENV: "test", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "unit-test-secret" };
const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, bodyText: JSON.stringify(json) });

describe("automatic monitoring after topic discovery", () => {
  let client: PGlite;
  let db: Database;
  let external: string;
  let id: string;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    const fixture = sourceIntelligenceFixtures().find((record) => record.provider === "youtube")!;
    external = fixture.account.external_account_id;
    await runSocialDiscovery(db, { providerKey: "youtube", query: "Pokemon TCG investing", env: { ISP_ENV: "test" },
      records: [{ ...fixture, content: { ...fixture.content, title: "Pokemon TCG investing market buy hold" } }],
    });
    const [creator] = await listDiscoveredCreators(db);
    expect(creator?.relevanceState).toBe("monitored");
    id = creator!.id;
    await client.exec("UPDATE provider_runtime SET mode='live', enabled=true, paused=false, credential_status='present' WHERE provider_key='youtube'");
  }, 30_000);
  afterAll(async () => { await client?.close(); });
  async function due() {
    await client.query("UPDATE discovered_creator SET next_monitor_at=now()-interval '1 minute', relevance_state='monitored' WHERE id=$1", [id]);
    await client.exec("UPDATE provider_runtime SET enabled=true, paused=false WHERE provider_key='youtube'");
  }
  const transport = (onVideos?: () => Promise<void>): HttpTransport => ({
    fetch: vi.fn(async (url, init) => {
      expect(url).not.toContain(env.YOUTUBE_API_KEY);
      expect(new URL(url).searchParams.has("key")).toBe(false);
      expect(init?.headers?.["x-goog-api-key"]).toBe(env.YOUTUBE_API_KEY);
      const u = new URL(url);
      if (u.pathname.endsWith("/channels")) {
        expect(u.searchParams.get("id")).toBe(external);
        return ok({ items: [{ id: external, contentDetails: { relatedPlaylists: { uploads: "uploads_discovered" } } }] });
      }
      if (u.pathname.endsWith("/playlistItems")) {
        expect(u.searchParams.get("maxResults")).toBe("10");
        return ok({ items: [{ contentDetails: { videoId: "new_upload" } }, { contentDetails: { videoId: "new_upload" } }] });
      }
      if (u.pathname.endsWith("/videos")) {
        await onVideos?.();
        return ok({ items: [{ id: "new_upload", snippet: { channelId: external, channelTitle: "Discovered channel", title: "Pokemon TCG market buy hold", publishedAt: "2026-09-01T00:00:00Z" }, statistics: { viewCount: "12345" } }] });
      }
      throw new Error("Unexpected endpoint");
    }),
  });
  it("discovers a channel from a topic, then polls future uploads without manual IDs", async () => {
    const http = transport();
    const result = await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http });
    expect(result).toMatchObject({ status: "completed", received: 1, requests: 3 });
    expect(http.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain(env.YOUTUBE_API_KEY);
    const [row] = await listDiscoveredCreators(db);
    expect(row?.lastMonitorSuccessAt).toBeInstanceOf(Date);
    expect(row?.nextMonitorAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row?.topicHits).toBe(1);
    const second = await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http });
    expect(second.status).toBe("skipped");
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });
  it("preserves one canonical video and separate engagement observations on later polls", async () => {
    await due();
    await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: transport() });
    const { rows } = await client.query<{ id: string }>("SELECT id FROM source_ingest WHERE payload->'content'->>'external_content_id'='new_upload'");
    expect(rows).toHaveLength(2);
    for (const row of rows) await normalizeSourceIntelligenceIngest(db, row.id);
    expect((await client.query("SELECT count(*)::int AS n FROM source_content WHERE external_content_id='new_upload'")).rows).toEqual([{ n: 1 }]);
    expect((await client.query("SELECT count(*)::int AS n FROM source_engagement_snapshot")).rows).toEqual([{ n: 2 }]);
  });
  it("claims the due creator once across overlapping invocations", async () => {
    await due();
    const http = transport();
    const reports = await Promise.all([runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http }), runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http })]);
    expect(reports.map((r) => r.status).sort()).toEqual(["completed", "skipped"]);
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });
  it("records provider failure and consumed budget without retrying in a loop", async () => {
    await due();
    const http: HttpTransport = { fetch: vi.fn(async () => ({ status: 503, headers: {}, bodyText: env.YOUTUBE_API_KEY })) };
    const report = await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http });
    expect(report).toMatchObject({ status: "failed", requests: 1, reason: "upstream_5xx" });
    expect(JSON.stringify(report)).not.toContain(env.YOUTUBE_API_KEY);
    expect((await listDiscoveredCreators(db))[0]?.monitorErrorClass).toBe("upstream_5xx");
    await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
  it("honors an exclusion while HTTP is in flight before persisting new content", async () => {
    await due();
    const http = transport(async () => { await client.query("UPDATE discovered_creator SET relevance_state='excluded' WHERE id=$1", [id]); });
    expect(await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http })).toMatchObject({ status: "skipped", reason: "operator_paused", received: 0 });
  });
  it("never polls paused providers or activates them because a key exists", async () => {
    await due();
    await client.exec("UPDATE provider_runtime SET paused=true WHERE provider_key='youtube'");
    const http = transport();
    expect((await runCreatorMonitoring(db, { providerKey: "youtube", env, transport: http })).status).toBe("skipped");
    expect((await runCreatorMonitoring(db, { providerKey: "youtube", env: { ISP_ENV: "staging", YOUTUBE_API_KEY: "unit-test-secret" }, transport: http })).status).toBe("skipped");
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe("Reddit monitored author adapter", () => {
  it("fetches the discovered author's posts with a bounded authenticated request", async () => {
    const { createLiveRedditProvider } = await import("./live-social.js");
    const paths: string[] = [];
    const api = createLiveRedditProvider({ REDDIT_CLIENT_ID: "test-client", REDDIT_CLIENT_SECRET: "test-secret", REDDIT_USER_AGENT: "test-agent" }, {
      async fetch(url) {
        paths.push(url);
        return url.includes("access_token") ? ok({ access_token: "test-access" }) : ok({ data: { children: [
          { data: { id: "newpost", author: "CardReviewer", title: "Pokemon market", permalink: "/r/PokemonTCG/comments/newpost", created_utc: 1788220800 } },
          { data: { id: "foreign", author: "AnotherAuthor", title: "Pokemon market", permalink: "/r/PokemonTCG/comments/foreign", created_utc: 1788220800 } },
        ] } });
      },
    })!;
    expect(await api.getRecentAuthorPosts("CardReviewer")).toHaveLength(1);
    expect(paths[1]).toContain("/user/CardReviewer/submitted?sort=new&limit=10");
    expect(paths.some((url) => url.includes("test-secret") || url.includes("test-access"))).toBe(false);
  });
});
