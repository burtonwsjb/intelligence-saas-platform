import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import type { TranscriptFetcher, TranscriptResult } from "../providers/transcripts.js";
import { user } from "../schema/auth.js";
import { creatorCall } from "../schema/creator.js";
import { sourceAccount, sourceContent } from "../schema/source.js";
import { providerSyncRun } from "../schema/provider.js";
import { buildCardNameIndex } from "./card-detect.js";
import {
  addTikTokVideoLinks,
  decideTikTokVideo,
  followTikTokCreator,
  listTikTokAccounts,
  parseTikTokProfileLink,
  parseTikTokVideoLink,
  claimTikTokProfileJobs,
  parseTikTokListingSubmission,
  setTikTokFollowState,
  submitTikTokProfileListing,
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

describe("parseTikTokListingSubmission", () => {
  it("keeps well-formed videos and refuses a malformed body", () => {
    const id = videoIdAt("2026-10-20T12:00:00Z");
    expect(
      parseTikTokListingSubmission({
        status: "ok",
        tool: "yt-dlp",
        videos: [
          { id, caption: "  Charizard   ex pulls ", timestamp: 1_792_670_400, duration: 31.6 },
          { id: "not-an-id", caption: "x" },
          { id: videoIdAt("2026-10-19T12:00:00Z"), caption: null },
        ],
      }),
    ).toEqual({
      status: "ok",
      tool: "yt-dlp",
      videos: [
        { videoId: id, caption: "Charizard ex pulls", createdAt: new Date(1_792_670_400_000), durationSeconds: 32 },
        { videoId: videoIdAt("2026-10-19T12:00:00Z"), caption: "", createdAt: null, durationSeconds: null },
      ],
    });
    expect(parseTikTokListingSubmission({ status: "error", reason: "ytdlp exit 1" })).toEqual({ status: "error", reason: "ytdlp_exit_1", tool: null });
    expect(() => parseTikTokListingSubmission({ status: "ok" })).toThrow();
    expect(() => parseTikTokListingSubmission({ videos: [] })).toThrow();
  });
});

describe("following a TikTok creator", () => {
  const NOW_SYNC = new Date("2026-10-25T12:00:00Z");
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const charizard = { id: videoIdAt("2026-10-24T10:00:00Z"), caption: "charizard ex 006 scarlet and violet is going up, buying now", timestamp: at("2026-10-24T10:00:00Z"), duration: 40 };
  const food = { id: videoIdAt("2026-10-23T10:00:00Z"), caption: "what I eat in a day", timestamp: at("2026-10-23T10:00:00Z") };
  const pulls = { id: videoIdAt("2026-10-22T10:00:00Z"), caption: "#pokemontcg pulls" };
  const tooOld = { id: videoIdAt("2025-06-01T10:00:00Z"), caption: "#pokemon old", timestamp: at("2025-06-01T10:00:00Z") };

  it("hands the owner's computer due profiles, keeps the card videos it lists and skips the rest", async () => {
    const { db, catalog } = await setup();
    const followed = await followTikTokCreator(db, {
      profile: "https://www.tiktok.com/@mitchy_stitchy",
      displayName: "Mitchy Stitchy",
      actorUserId: ADMIN,
    });
    expect(followed.handle).toBe("mitchy_stitchy");
    const before = await submitTikTokProfileListing(db, {
      sourceAccountId: followed.sourceAccountId,
      submission: { status: "ok", videos: [], tool: null },
    });
    expect(before).toEqual({ outcome: "not_claimed", sourceAccountId: followed.sourceAccountId });

    const [job, ...rest] = await claimTikTokProfileJobs(db, { worker: "DESKTOP", now: NOW_SYNC });
    expect(rest).toEqual([]);
    expect(job).toEqual({
      source_account_id: followed.sourceAccountId,
      handle: "mitchy_stitchy",
      profile_url: "https://www.tiktok.com/@mitchy_stitchy",
      since: "2025-10-25T12:00:00.000Z",
      max_videos: 300,
      first_check: true,
    });
    // Claimed: not handed out again until the claim lapses.
    expect(await claimTikTokProfileJobs(db, { now: NOW_SYNC })).toEqual([]);

    const report = await submitTikTokProfileListing(db, {
      sourceAccountId: followed.sourceAccountId,
      submission: parseTikTokListingSubmission({ status: "ok", tool: "yt-dlp", videos: [charizard, food, pulls, tooOld] }),
      now: NOW_SYNC,
    });
    expect(report).toMatchObject({ outcome: "listed", listed: 3, kept: 2, skipped: 1, callsCreated: 1 });
    const videos = await db.select().from(sourceContent).where(eq(sourceContent.accountId, followed.sourceAccountId));
    expect(videos.map((video) => video.externalContentId).sort()).toEqual([charizard.id, pulls.id].sort());
    const pulled = videos.find((video) => video.externalContentId === pulls.id)!;
    // No timestamp from the tool: the date comes from the video id.
    expect(pulled.publishedAt.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect(pulled.title).toBe("#pokemontcg pulls");
    const [call] = await db.select().from(creatorCall);
    expect(call).toMatchObject({ creatorId: followed.creatorId, printingId: catalog.printings.charizardStandard.id, direction: "bullish" });
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "tiktok"));
    expect(run).toMatchObject({ status: "completed", receivedCount: 2 });
    expect(run!.checkpoint).toMatchObject({
      handle: "mitchy_stitchy",
      worker: "DESKTOP",
      tool: "yt-dlp",
      kept: 2,
      skipped: 1,
      skipped_samples: ["what I eat in a day"],
      newest_at: "2026-10-24T10:00:00.000Z",
    });
    expect(await listTikTokAccounts(db)).toMatchObject([{ handle: "mitchy_stitchy", followState: "active", videos: 2, lastKept: 2, lastSkipped: 1 }]);
    // The run is finished, so a second answer for it is refused.
    expect(
      await submitTikTokProfileListing(db, { sourceAccountId: followed.sourceAccountId, submission: { status: "ok", videos: [], tool: null } }),
    ).toMatchObject({ outcome: "not_claimed" });
  });

  it("starts a later listing from the newest video already seen", async () => {
    const { db } = await setup();
    const followed = await followTikTokCreator(db, { profile: "@mitchy_stitchy", actorUserId: ADMIN });
    await claimTikTokProfileJobs(db, { now: NOW_SYNC });
    await submitTikTokProfileListing(db, {
      sourceAccountId: followed.sourceAccountId,
      submission: parseTikTokListingSubmission({ status: "ok", videos: [charizard] }),
      now: NOW_SYNC,
    });
    // Let the 12-hour interval pass.
    await db.execute(sql`UPDATE provider_sync_run SET started_at = now() - interval '13 hours' WHERE provider_key = 'tiktok'`);
    const [job] = await claimTikTokProfileJobs(db, { now: NOW_SYNC });
    expect(job).toMatchObject({ since: "2026-10-24T10:00:00.000Z", max_videos: 60, first_check: false });
    const fresh = { id: videoIdAt("2026-10-25T09:00:00Z", 7n), caption: "booster box opening", timestamp: at("2026-10-25T09:00:00Z") };
    const again = await submitTikTokProfileListing(db, {
      sourceAccountId: followed.sourceAccountId,
      submission: parseTikTokListingSubmission({ status: "ok", videos: [fresh, charizard, food] }),
      now: NOW_SYNC,
    });
    expect(again).toMatchObject({ listed: 1, kept: 1, skipped: 0 });
  });

  it("skips paused creators and a paused provider, and records a failed listing", async () => {
    const { db } = await setup();
    const followed = await followTikTokCreator(db, { profile: "@mitchy_stitchy", actorUserId: ADMIN });
    await setTikTokFollowState(db, { sourceAccountId: followed.sourceAccountId, state: "paused", actorUserId: ADMIN });
    expect(await claimTikTokProfileJobs(db, { now: NOW_SYNC })).toEqual([]);
    await followTikTokCreator(db, { profile: "@mitchy_stitchy", actorUserId: ADMIN });
    await db.execute(sql`UPDATE provider_runtime SET paused = true WHERE provider_key = 'tiktok'`);
    expect(await claimTikTokProfileJobs(db, { now: NOW_SYNC })).toEqual([]);
    await db.execute(sql`UPDATE provider_runtime SET paused = false WHERE provider_key = 'tiktok'`);
    expect(await claimTikTokProfileJobs(db, { now: NOW_SYNC })).toHaveLength(1);
    const failed = await submitTikTokProfileListing(db, {
      sourceAccountId: followed.sourceAccountId,
      submission: parseTikTokListingSubmission({ status: "error", reason: "ytdlp_exit_1", tool: "yt-dlp" }),
    });
    expect(failed).toMatchObject({ outcome: "failed", kept: 0 });
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "tiktok"));
    expect(run).toMatchObject({ status: "failed", errorClass: "ytdlp_exit_1" });
  });

  it("refuses links that are not TikTok profiles", async () => {
    const { db } = await setup();
    await expect(followTikTokCreator(db, { profile: "https://www.youtube.com/@x", actorUserId: ADMIN })).rejects.toMatchObject({ code: "invalid_profile" });
  });
});
