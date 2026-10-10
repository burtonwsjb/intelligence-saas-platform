import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import { ensureCreatorForSourceAccount } from "../creator/ingest.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceContent, sourceMention } from "../schema/source.js";
import { stableSourceId, type SourceContentRecordInput } from "./identity.js";
import { YOUTUBE_BACKFILL_TRIGGER, listYoutubeBackfillProgress, runYoutubeBackfill, runYoutubeBackfillBatch } from "./youtube-backfill.js";

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const OTHER = "UCzyxwvutsrqponmlkjihgfe";

function video(id: string, publishedAt: string, title: string, channel = CHANNEL): SourceContentRecordInput {
  return {
    provider: "youtube",
    provider_record_id: id,
    event_type: "source.content.ingested",
    account: { external_account_id: channel, handle: "@cardtalk", display_name: "Card Talk", canonical_url: `https://www.youtube.com/channel/${channel}` },
    content: {
      external_content_id: id,
      content_type: "video",
      published_at: publishedAt,
      title,
      summary: null,
      canonical_url: `https://www.youtube.com/watch?v=${id}`,
      language: "en",
    },
  };
}

const VIDEOS: Record<string, { record: SourceContentRecordInput; description: string }> = {
  vid_new_001: {
    record: video("vid_new_001", "2026-05-01T15:00:00.000Z", "My top buy this month"),
    description: "I would buy Charizard ex 006 from Scarlet & Violet before it goes up.\nMerch: https://shop.example/pikachu",
  },
  vid_mid_002: { record: video("vid_mid_002", "2026-03-01T15:00:00.000Z", "Vlog"), description: "No cards today." },
  vid_foreign: { record: video("vid_foreign", "2026-03-02T15:00:00.000Z", "Charizard ex 006", OTHER), description: "" },
  vid_old_003: { record: video("vid_old_003", "2025-08-01T15:00:00.000Z", "Pikachu talk"), description: "Pikachu is cheap." },
};

const PAGES: Record<string, { items: Array<{ videoId: string; publishedAt: string | null }>; nextPageToken: string | null }> = {
  first: {
    items: [
      { videoId: "vid_new_001", publishedAt: "2026-05-01T15:00:00Z" },
      { videoId: "vid_mid_002", publishedAt: "2026-03-01T15:00:00Z" },
      { videoId: "vid_foreign", publishedAt: "2026-03-02T15:00:00Z" },
    ],
    nextPageToken: "PAGE2",
  },
  PAGE2: {
    items: [
      { videoId: "vid_old_003", publishedAt: "2025-08-01T15:00:00Z" },
      { videoId: "vid_ancient", publishedAt: "2024-01-01T15:00:00Z" },
    ],
    nextPageToken: "PAGE3",
  },
};

function fakeYoutube() {
  const log: string[] = [];
  const provider = {
    async getUploadsPlaylistId(channelId: string) {
      log.push(`channels:${channelId}`);
      return "UUabcdefghijklmnopqrstuv";
    },
    async getUploadsPage(_playlistId: string, pageToken: string | null) {
      log.push(`playlistItems:${pageToken ?? "first"}`);
      return PAGES[pageToken ?? "first"]!;
    },
    async getVideoDetails(ids: string[]) {
      log.push(`videos:${ids.join(",")}`);
      return ids.map((id) => VIDEOS[id]).filter((row): row is (typeof VIDEOS)[string] => Boolean(row));
    },
  };
  return { log, provider, requestCount: () => log.length };
}

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  // The account id ingestion derives for this channel, so backfilled videos land on it.
  const accountId = stableSourceId("sac", ["youtube", CHANNEL]);
  await client.exec(`UPDATE provider_runtime SET mode='live', enabled=true, paused=false WHERE provider_key='youtube';`);
  await client.query(
    `INSERT INTO source_account (id, source_type, external_account_id, handle, display_name, first_seen_at, last_seen_at)
     VALUES ($1, 'youtube', $2, '@cardtalk', 'Card Talk', now(), now())`,
    [accountId, CHANNEL],
  );
  const { creator } = await ensureCreatorForSourceAccount(db, accountId);
  await client.query(
    `INSERT INTO discovered_creator (id, creator_id, source_account_id, provider_key, external_account_id, display_name, relevance_state, discovery_provenance)
     VALUES ('dc_cardtalk', $1, $2, 'youtube', $3, 'Card Talk', 'monitored', '{"operator_seed": true}'::jsonb)`,
    [creator.id, accountId, CHANNEL],
  );
  return db;
}

describe("YouTube uploads backfill", () => {
  it("walks the uploads playlist back to the cutoff across runs and finds cards in titles and descriptions", async () => {
    const db = await setup();
    const now = new Date("2026-06-01T00:00:00Z");
    const yt = fakeYoutube();

    // One page per run, so the second run must resume from the saved page token.
    const first = await runYoutubeBackfillBatch(db, { provider: yt.provider, requestCount: yt.requestCount, budget: 60, days: 365, now, maxPagesPerRun: 1 });
    expect(first).toMatchObject({ status: "completed", channels: 1, finished: 0, pages: 1, videos: 2, stored: 2, mentions: 1 });
    expect(yt.log).toEqual([`channels:${CHANNEL}`, "playlistItems:first", "videos:vid_new_001,vid_mid_002,vid_foreign"]);

    const [stored] = await db.select().from(sourceContent).where(eq(sourceContent.externalContentId, "vid_new_001"));
    expect(stored).toBeTruthy();
    const mentions = await db.select().from(sourceMention).where(eq(sourceMention.contentId, stored!.id));
    expect(mentions.map((row) => row.rawEntityText)).toEqual(["Charizard ex 006"]);
    expect(JSON.stringify(mentions)).not.toContain("shop.example");
    // Another channel's video is never attached to this creator.
    expect(await db.select().from(sourceContent).where(eq(sourceContent.externalContentId, "vid_foreign"))).toEqual([]);

    const second = await runYoutubeBackfillBatch(db, { provider: yt.provider, requestCount: yt.requestCount, budget: 60, days: 365, now: new Date(now.getTime() + 3_600_000), maxPagesPerRun: 1 });
    expect(second).toMatchObject({ status: "completed", channels: 1, finished: 1, pages: 1, videos: 1 });
    // The uploads id is not looked up again, the page token is resumed, and the old upload is not fetched.
    expect(yt.log.slice(3)).toEqual(["playlistItems:PAGE2", "videos:vid_old_003"]);

    const runs = await db
      .select()
      .from(providerSyncRun)
      .where(and(eq(providerSyncRun.providerKey, "youtube"), eq(providerSyncRun.trigger, YOUTUBE_BACKFILL_TRIGGER)));
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.limitCount).sort()).toEqual([2, 3]);
    expect(await listYoutubeBackfillProgress(db)).toMatchObject([
      { channelId: CHANNEL, done: true, outcome: "reached_cutoff", pages: 2, videosStored: 3 },
    ]);

    // Done channels are not read again.
    const third = await runYoutubeBackfillBatch(db, { provider: yt.provider, requestCount: yt.requestCount, budget: 60, days: 365, now: new Date(now.getTime() + 7_200_000) });
    expect(third).toMatchObject({ status: "skipped", reason: "nothing_to_backfill" });
    expect(yt.log).toHaveLength(5);
  });

  it("stops for the day when the backfill's daily cap is spent", async () => {
    const db = await setup();
    const yt = fakeYoutube();
    const report = await runYoutubeBackfillBatch(db, { provider: yt.provider, requestCount: yt.requestCount, budget: 2, days: 365, now: new Date("2026-06-01T00:00:00Z") });
    expect(report).toMatchObject({ status: "stopped", reason: "budget_exhausted", channels: 0 });
    expect(yt.log).toEqual([]);
  });

  it("is off unless YOUTUBE_BACKFILL_DAYS is set and YouTube is live", async () => {
    const untouched = {
      transaction: async () => {
        throw new Error("unexpected");
      },
    } as unknown as Database;
    expect(await runYoutubeBackfill(untouched, { env: {} })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(await runYoutubeBackfill(untouched, { env: { YOUTUBE_BACKFILL_DAYS: "365" } })).toMatchObject({
      status: "skipped",
      reason: "not_live_or_credentialed",
    });
  });
});
