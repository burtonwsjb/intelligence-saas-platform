import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import type { TranscriptFetcher, TranscriptResult } from "../providers/transcripts.js";
import { user } from "../schema/auth.js";
import { creatorCall } from "../schema/creator.js";
import { sourceAccount, sourceContent } from "../schema/source.js";
import { addTikTokVideoLinks, parseTikTokVideoLink, tiktokAccountId, tiktokVideoTime, listTikTokAccounts } from "./tiktok-ingest.js";
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
