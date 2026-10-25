import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import type { TranscriptFetcher, TranscriptResult } from "../providers/transcripts.js";
import { user } from "../schema/auth.js";
import { creatorCall } from "../schema/creator.js";
import { sourceAccount, sourceContent } from "../schema/source.js";
import { providerSyncRun } from "../schema/provider.js";
import { ScrapeCreatorsTikTokLister, parseTikTokVideoPage, type TikTokListPage, type TikTokVideoLister } from "../providers/tiktok-videos.js";
import type { HttpTransport } from "../providers/transport.js";
import { buildCardNameIndex } from "./card-detect.js";
import {
  addTikTokVideoLinks,
  decideTikTokVideo,
  followTikTokCreator,
  listTikTokAccounts,
  parseTikTokProfileLink,
  parseTikTokVideoLink,
  runTikTokProfileSyncBatch,
  setTikTokFollowState,
  syncTikTokProfiles,
  tiktokAccountId,
  tiktokVideoTime,
} from "./tiktok-ingest.js";
import { runTranscriptBackfillBatch } from "./transcript-ingest.js";

const ADMIN = "user_admin";
// Upload time 2026-09-10T00:26:40Z is in the id's top 32 bits.
const VIDEO = "7683696492667456789";
const LINK = `https://www.tiktok.com/@MitchyStitchy/video/${VIDEO}?is_from_webapp=1&sender_device=pc`;
const NOW = new Date("2026-10-25T00:00:00Z");

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const catalog = await seedTcgIdentityFixtures(db);
  await db.insert(user).values({ id: ADMIN, name: "Admin", email: "admin@example.com", emailVerified: true });
  return { db, catalog };
}

describe("parseTikTokVideoLink", () => {
  it("reads the creator, video id and upload time, and refuses other links", () => {
    expect(parseTikTokVideoLink(LINK, NOW)).toEqual({
      handle: "mitchystitchy",
      videoId: VIDEO,
      url: `https://www.tiktok.com/@mitchystitchy/video/${VIDEO}`,
      publishedAt: new Date("2026-09-10T00:26:40Z"),
    });
    expect(parseTikTokVideoLink("https://vm.tiktok.com/ZMabc123/", NOW)).toBeNull();
    expect(parseTikTokVideoLink("https://www.tiktok.com/@mitchystitchy", NOW)).toBeNull();
    expect(parseTikTokVideoLink(`https://evil.example.com/@x/video/${VIDEO}`, NOW)).toBeNull();
    expect(tiktokVideoTime("123456789012345", NOW)).toBeNull();
  });
});

describe("addTikTokVideoLinks", () => {
  it("stores pasted links as dated videos of one creator, idempotently", async () => {
    const { db } = await setup();
    const report = await addTikTokVideoLinks(db, {
      links: `${LINK}\nnot a link\n${LINK}`,
      displayName: "Mitchy Stitchy",
      actorUserId: ADMIN,
      now: NOW,
    });
    expect(report).toMatchObject({ added: 1, duplicates: 0, rejected: ["not", "a", "link"] });
    expect(report.accounts).toEqual([
      { handle: "mitchystitchy", sourceAccountId: tiktokAccountId("mitchystitchy"), creatorId: expect.any(String) },
    ]);
    const [account] = await db.select().from(sourceAccount).where(eq(sourceAccount.id, tiktokAccountId("mitchystitchy")));
    expect(account).toMatchObject({ sourceType: "tiktok", handle: "mitchystitchy", displayName: "Mitchy Stitchy" });
    const [video] = await db.select().from(sourceContent).where(eq(sourceContent.externalContentId, VIDEO));
    expect(video).toMatchObject({ sourceType: "tiktok", contentType: "video", canonicalUrl: `https://www.tiktok.com/@mitchystitchy/video/${VIDEO}` });
    expect(video!.publishedAt.toISOString()).toBe("2026-09-10T00:26:40.000Z");

    const again = await addTikTokVideoLinks(db, { links: LINK, actorUserId: ADMIN, now: NOW });
    expect(again).toMatchObject({ added: 0, duplicates: 1 });
  });
});

describe("TikTok transcripts", () => {
  const transcript: TranscriptResult = {
    status: "ok",
    lang: "en",
    trackKind: "unknown",
    cues: [
      { text: "okay quick one", offsetMs: 0, durationMs: 2_000 },
      { text: "i would buy charizard ex 006 from scarlet and violet it will go up in a month", offsetMs: 4_000, durationMs: 5_000 },
    ],
  };

  it("are fetched by URL through a service that offers it, first, and become calls", async () => {
    const { db, catalog } = await setup();
    const { accounts } = await addTikTokVideoLinks(db, { links: LINK, actorUserId: ADMIN, now: NOW });
    const urls: string[] = [];
    const service: TranscriptFetcher = {
      provider: "supadata",
      maxRequestsPerVideo: 13,
      fetch: async () => {
        throw new Error("YouTube ids are not used for TikTok");
      },
      fetchUrl: async (url) => {
        urls.push(url);
        return { ...transcript, requests: 1 };
      },
    };
    const report = await runTranscriptBackfillBatch(db, service, { budget: 50, maxVideos: 1 });
    expect(report).toMatchObject({ checked: 1, ingested: 1, callsCreated: 1 });
    expect(urls).toEqual([`https://www.tiktok.com/@mitchystitchy/video/${VIDEO}`]);
    const calls = await db.select().from(creatorCall);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ creatorId: accounts[0]!.creatorId, printingId: catalog.printings.charizardStandard.id, direction: "bullish" });
    expect(await listTikTokAccounts(db)).toMatchObject([{ handle: "mitchystitchy", videos: 1, transcribed: 1, calls: 1 }]);
  });

  it("are skipped by a fetcher that only reads YouTube captions", async () => {
    const { db } = await setup();
    await addTikTokVideoLinks(db, { links: LINK, actorUserId: ADMIN, now: NOW });
    const captions: TranscriptFetcher = {
      provider: "youtube_captions",
      maxRequestsPerVideo: 2,
      fetch: async () => {
        throw new Error("unexpected");
      },
    };
    expect(await runTranscriptBackfillBatch(db, captions, { budget: 50 })).toMatchObject({ status: "skipped", reason: "nothing_to_check" });
  });
});

/** A TikTok video id whose top 32 bits are the given time. */
function videoIdAt(iso: string, low = 1n) {
  return ((BigInt(Math.floor(Date.parse(iso) / 1000)) << 32n) | low).toString();
}

describe("parseTikTokProfileLink", () => {
  it("reads the handle from profile links, video links and bare handles", () => {
    expect(parseTikTokProfileLink("https://www.tiktok.com/@mitchy_stitchy")).toBe("mitchy_stitchy");
    expect(parseTikTokProfileLink("https://www.tiktok.com/@Mitchy_Stitchy?lang=en&is_from_webapp=1")).toBe("mitchy_stitchy");
    expect(parseTikTokProfileLink("tiktok.com/@mitchy_stitchy/")).toBe("mitchy_stitchy");
    expect(parseTikTokProfileLink("@mitchy_stitchy")).toBe("mitchy_stitchy");
    expect(parseTikTokProfileLink("mitchy_stitchy")).toBe("mitchy_stitchy");
    expect(parseTikTokProfileLink(LINK)).toBe("mitchystitchy");
    expect(parseTikTokProfileLink("https://vm.tiktok.com/ZMabc123/")).toBeNull();
    expect(parseTikTokProfileLink("https://www.youtube.com/@mitchy_stitchy")).toBeNull();
    expect(parseTikTokProfileLink("https://www.tiktok.com/discover/pokemon")).toBeNull();
    expect(parseTikTokProfileLink("")).toBeNull();
  });
});

describe("decideTikTokVideo", () => {
  const index = buildCardNameIndex({ cards: [{ name: "Charizard ex", gameKey: "pokemon" }], sets: [] });
  it("keeps card videos and skips the rest, from the caption", () => {
    expect(decideTikTokVideo("Is Charizard ex a buy right now?", index)).toEqual({ keep: true, reason: "card_name" });
    expect(decideTikTokVideo("#pokemontcg #fyp", index)).toEqual({ keep: true, reason: "card_words" });
    expect(decideTikTokVideo("opening 10 booster packs", index)).toEqual({ keep: true, reason: "card_words" });
    expect(decideTikTokVideo("got my PSA 10 back", index)).toEqual({ keep: true, reason: "card_words" });
    expect(decideTikTokVideo("One Piece card market is wild", index)).toEqual({ keep: true, reason: "card_words" });
    expect(decideTikTokVideo("what I eat in a day 🍝 #fyp", index)).toEqual({ keep: false, reason: "no_card_signal" });
    expect(decideTikTokVideo("   ", index)).toEqual({ keep: false, reason: "no_caption" });
  });
});

describe("parseTikTokVideoPage", () => {
  it("reads aweme_list videos as a list or keyed object, defensively", () => {
    const id = videoIdAt("2026-10-20T12:00:00Z");
    const page = parseTikTokVideoPage({
      aweme_list: [
        { aweme_id: id, desc: "  Charizard   ex pulls ", create_time: 1_792_670_400, video: { duration: 31_500 }, is_top: 1 },
        { aweme_id: "not-an-id", desc: "x" },
        { aweme_id: videoIdAt("2026-10-19T12:00:00Z"), desc: "no time" },
      ],
      max_cursor: 1_792_000_000_000,
      has_more: 1,
    });
    expect(page).toEqual({
      videos: [
        { videoId: id, caption: "Charizard ex pulls", createdAt: new Date(1_792_670_400_000), durationSeconds: 32, pinned: true, isAd: false },
        { videoId: videoIdAt("2026-10-19T12:00:00Z"), caption: "no time", createdAt: null, durationSeconds: null, pinned: false, isAd: false },
      ],
      nextCursor: "1792000000000",
      hasMore: true,
    });
    const keyed = parseTikTokVideoPage({ aweme_list: { "0": { aweme_id: id, desc: "a" } }, has_more: false });
    expect(keyed?.videos.map((video) => video.videoId)).toEqual([id]);
    expect(keyed?.hasMore).toBe(false);
    expect(parseTikTokVideoPage({ error: "nope" })).toBeNull();
  });
});

describe("ScrapeCreatorsTikTokLister", () => {
  it("asks for the newest videos with the key in a header and maps failures", async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    let status = 200;
    const transport: HttpTransport = {
      fetch: async (url, init) => {
        calls.push({ url, headers: init?.headers });
        return { status, headers: {}, bodyText: JSON.stringify({ aweme_list: [], has_more: 0 }) };
      },
    };
    const lister = new ScrapeCreatorsTikTokLister({ apiKey: "test-key", transport });
    expect(await lister.listPage("mitchy_stitchy", "123")).toEqual({ status: "ok", videos: [], nextCursor: null, hasMore: false });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.scrapecreators.com/v3/tiktok/profile/videos");
    expect(Object.fromEntries(url.searchParams)).toEqual({ handle: "mitchy_stitchy", sort_by: "latest", trim: "true", max_cursor: "123" });
    expect(calls[0]!.headers?.["x-api-key"]).toBe("test-key");
    expect(calls[0]!.url).not.toContain("test-key");
    status = 404;
    expect(await lister.listPage("mitchy_stitchy", null)).toEqual({ status: "not_found", reason: "no_such_profile" });
    status = 402;
    expect(await lister.listPage("mitchy_stitchy", null)).toEqual({ status: "rate_limited", reason: "out_of_credits" });
    expect(await lister.listPage("Bad Handle!", null)).toEqual({ status: "error", reason: "invalid_handle" });
  });
});

describe("following a TikTok creator", () => {
  const NOW_SYNC = new Date("2026-10-25T12:00:00Z");
  const charizard = { videoId: videoIdAt("2026-10-24T10:00:00Z"), caption: "charizard ex 006 scarlet and violet is going up, buying now", createdAt: new Date("2026-10-24T10:00:00Z"), durationSeconds: 40, pinned: false, isAd: false };
  const food = { videoId: videoIdAt("2026-10-23T10:00:00Z"), caption: "what I eat in a day", createdAt: new Date("2026-10-23T10:00:00Z"), durationSeconds: 20, pinned: false, isAd: false };
  const pulls = { videoId: videoIdAt("2026-10-22T10:00:00Z"), caption: "#pokemontcg pulls", createdAt: null, durationSeconds: 25, pinned: false, isAd: false };
  const oldPinned = { videoId: videoIdAt("2024-01-01T10:00:00Z"), caption: "#pokemon pinned forever", createdAt: new Date("2024-01-01T10:00:00Z"), durationSeconds: 25, pinned: true, isAd: false };
  const tooOld = { videoId: videoIdAt("2025-06-01T10:00:00Z"), caption: "#pokemon old", createdAt: new Date("2025-06-01T10:00:00Z"), durationSeconds: 25, pinned: false, isAd: false };

  function fakeLister(pages: TikTokListPage[]): TikTokVideoLister & { asked: Array<string | null> } {
    const asked: Array<string | null> = [];
    return {
      provider: "scrapecreators",
      asked,
      listPage: async (_handle, cursor) => {
        asked.push(cursor);
        return pages[asked.length - 1] ?? { status: "ok", videos: [], nextCursor: null, hasMore: false };
      },
    };
  }

  it("lists the creator's videos, keeps the card ones and stops at the backfill window", async () => {
    const { db, catalog } = await setup();
    const followed = await followTikTokCreator(db, {
      profile: "https://www.tiktok.com/@mitchy_stitchy",
      displayName: "Mitchy Stitchy",
      actorUserId: ADMIN,
    });
    expect(followed.handle).toBe("mitchy_stitchy");
    const lister = fakeLister([
      { status: "ok", videos: [oldPinned, charizard, food], nextCursor: "c1", hasMore: true },
      { status: "ok", videos: [pulls, tooOld], nextCursor: "c2", hasMore: true },
    ]);
    const report = await runTikTokProfileSyncBatch(db, { lister, budget: 60, now: NOW_SYNC });
    expect(report).toMatchObject({ status: "completed", creators: 1, requests: 2, listed: 3, kept: 2, skipped: 1, callsCreated: 1 });
    // The walk ended at the first unpinned video older than a year; the pinned one did not end it.
    expect(lister.asked).toEqual([null, "c1"]);
    const videos = await db.select().from(sourceContent).where(eq(sourceContent.accountId, followed.sourceAccountId));
    expect(videos.map((video) => video.externalContentId).sort()).toEqual([charizard.videoId, pulls.videoId].sort());
    const pulled = videos.find((video) => video.externalContentId === pulls.videoId)!;
    expect(pulled.publishedAt.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect(pulled.title).toBe("#pokemontcg pulls");
    const [call] = await db.select().from(creatorCall);
    expect(call).toMatchObject({ creatorId: followed.creatorId, printingId: catalog.printings.charizardStandard.id, direction: "bullish" });
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "tiktok"));
    expect(run).toMatchObject({ status: "completed", limitCount: 2, receivedCount: 2 });
    expect(run!.checkpoint).toMatchObject({ handle: "mitchy_stitchy", kept: 2, skipped: 1, skipped_samples: ["what I eat in a day"], newest_at: "2026-10-24T10:00:00.000Z" });
    expect(await listTikTokAccounts(db)).toMatchObject([{ handle: "mitchy_stitchy", followState: "active", videos: 2, lastKept: 2, lastSkipped: 1 }]);

    // Not due again for 12 hours.
    expect(await runTikTokProfileSyncBatch(db, { lister, budget: 60, now: NOW_SYNC })).toMatchObject({ status: "skipped", reason: "nothing_due" });

    // A later check stops at the newest video already seen.
    const fresh = { ...charizard, videoId: videoIdAt("2026-10-25T09:00:00Z", 7n), caption: "booster box opening", createdAt: new Date("2026-10-25T09:00:00Z") };
    const later = fakeLister([{ status: "ok", videos: [fresh, charizard, food], nextCursor: "n1", hasMore: true }]);
    const again = await runTikTokProfileSyncBatch(db, { lister: later, budget: 60, now: NOW_SYNC, intervalHours: 0 });
    expect(again).toMatchObject({ creators: 1, requests: 1, listed: 1, kept: 1, skipped: 0 });
    expect(later.asked).toEqual([null]);
  });

  it("skips paused creators, stops at the daily budget and records failures", async () => {
    const { db } = await setup();
    const followed = await followTikTokCreator(db, { profile: "@mitchy_stitchy", actorUserId: ADMIN });
    await setTikTokFollowState(db, { sourceAccountId: followed.sourceAccountId, state: "paused", actorUserId: ADMIN });
    const lister = fakeLister([]);
    expect(await runTikTokProfileSyncBatch(db, { lister, budget: 60, now: NOW_SYNC })).toMatchObject({ status: "skipped", reason: "nothing_due" });
    await followTikTokCreator(db, { profile: "@mitchy_stitchy", actorUserId: ADMIN });
    // The first check reserves 10 pages.
    expect(await runTikTokProfileSyncBatch(db, { lister, budget: 5, now: NOW_SYNC })).toMatchObject({ status: "stopped", reason: "budget_exhausted" });
    const failing = fakeLister([{ status: "not_found", reason: "no_such_profile" }]);
    expect(await runTikTokProfileSyncBatch(db, { lister: failing, budget: 60, now: NOW_SYNC })).toMatchObject({ creators: 1, failed: 1, kept: 0 });
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "tiktok"));
    expect(run).toMatchObject({ status: "failed", errorClass: "no_such_profile", limitCount: 1 });
  });

  it("refuses links that are not TikTok profiles and stays off unless live with a key", async () => {
    const { db } = await setup();
    await expect(followTikTokCreator(db, { profile: "https://www.youtube.com/@x", actorUserId: ADMIN })).rejects.toMatchObject({ code: "invalid_profile" });
    expect(await syncTikTokProfiles(db, { env: { ISP_ENV: "test" } })).toMatchObject({ status: "skipped", reason: "fixture_not_supported" });
    expect(await syncTikTokProfiles(db, { env: { ISP_ENV: "test", PROVIDER_TIKTOK_MODE: "disabled" } })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(await syncTikTokProfiles(db, { env: { ISP_ENV: "test", PROVIDER_TIKTOK_MODE: "live" } })).toMatchObject({ status: "skipped", reason: "missing_key" });
  });
});
