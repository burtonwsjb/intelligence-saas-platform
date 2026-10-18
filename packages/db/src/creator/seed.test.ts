import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";
import { listInfluencerSeedStatus, requestInfluencerSeed, resolvePendingInfluencerSeeds, type InfluencerSeedEntry } from "./seed.js";

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, bodyText: JSON.stringify(json) });
const youtubeEnv = { ISP_ENV: "test", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "unit-test-secret" };
const FOUND = "UCabcdefghijklmnopqrstuv";
const MISSING = "UCzyxwvutsrqponmlkjihgfe";
const ADMIN = "user_seed_admin";

const blank = { youtubeChannelId: null, youtubeHandle: null, youtubeUrl: null, websiteUrl: null, feedUrl: null, newsletterUrl: null, makesSpecificCalls: "some" };
const ENTRIES: InfluencerSeedEntry[] = [
  {
    ...blank,
    rank: 1,
    name: "Cards Blog",
    youtubeHandle: "@CardsBlog",
    websiteUrl: "https://cards.example.com/blog",
    newsletterUrl: "https://www.patreon.com/cardsblog",
  },
  { ...blank, rank: 2, name: "Unverified Channel" },
  { ...blank, rank: 3, name: "Gone Channel", youtubeChannelId: MISSING },
];

describe("influencer seed list", () => {
  let client: PGlite;
  let db: Database;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await client.exec(`
      INSERT INTO "user" (id, name, email) VALUES ('${ADMIN}', 'Admin', 'seed-admin@example.test');
      UPDATE provider_runtime SET mode='live', enabled=true, paused=false, credential_status='present' WHERE provider_key='youtube';
    `);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("registers websites, queues channels and reports the rest, idempotently and audited", async () => {
    const env = { NODE_ENV: "test" };
    const first = await requestInfluencerSeed(db, { actorUserId: ADMIN, env, entries: ENTRIES, version: "test.v1" });
    expect(first).toMatchObject({ channelsQueued: 2, channelsSkipped: 1, sitesRegistered: 1, sitesAlreadyRegistered: 0, sitesSkipped: 1 });
    const again = await requestInfluencerSeed(db, { actorUserId: ADMIN, env, entries: ENTRIES, version: "test.v1" });
    expect(again).toMatchObject({ channelsQueued: 0, sitesRegistered: 0, sitesAlreadyRegistered: 1, sitesSkipped: 1 });

    const rows = await listInfluencerSeedStatus(db);
    const summary = rows.map((row) => [row.rank, row.kind, row.status, row.outcome].join(" ")).sort();
    expect(summary).toEqual([
      "1 website completed registered",
      "1 website skipped shared_platform",
      "1 youtube started pending",
      "2 youtube skipped no_handle",
      "3 youtube started pending",
    ]);
    const audits = await client.query(`SELECT 1 FROM platform_break_glass_audit WHERE target_type = 'influencer_seed'`);
    expect(audits.rows).toHaveLength(2);
  });

  it("resolves queued channels with one data request each and never guesses a missing one", async () => {
    const http: HttpTransport = {
      fetch: vi.fn(async (raw: string) => {
        const url = new URL(raw);
        expect(url.pathname).toBe("/youtube/v3/channels");
        if (url.searchParams.get("forHandle") === "@cardsblog") {
          return ok({ items: [{ id: FOUND, snippet: { title: "Cards Blog", customUrl: "@cardsblog" } }] });
        }
        expect(url.searchParams.get("id")).toBe(MISSING);
        return ok({ items: [] });
      }),
    };
    const report = await resolvePendingInfluencerSeeds(db, { env: youtubeEnv, transport: http });
    expect(report).toMatchObject({ status: "completed", resolved: 1, notFound: 1, requests: 2 });
    expect(http.fetch).toHaveBeenCalledTimes(2);

    const monitored = await client.query<{ relevance_state: string; discovery_provenance: Record<string, unknown> }>(
      `SELECT relevance_state, discovery_provenance FROM discovered_creator WHERE external_account_id = $1`,
      [FOUND],
    );
    expect(monitored.rows[0]?.relevance_state).toBe("monitored");
    expect(monitored.rows[0]?.discovery_provenance).toMatchObject({ operator_seed: true, source: "operator_seed", seed_rank: 1 });

    const rows = await listInfluencerSeedStatus(db);
    expect(rows.find((row) => row.rank === 1 && row.kind === "youtube")).toMatchObject({ outcome: "resolved", externalAccountId: FOUND });
    expect(rows.find((row) => row.rank === 3)).toMatchObject({ status: "skipped", outcome: "not_found" });

    // Nothing left to look up.
    const idle = await resolvePendingInfluencerSeeds(db, { env: youtubeEnv, transport: http });
    expect(idle).toMatchObject({ status: "skipped", reason: "no_pending_seeds" });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});
