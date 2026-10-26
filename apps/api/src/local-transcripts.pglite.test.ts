import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  followTikTokCreator,
  ingestPodcastEpisode,
  loadCardNameIndex,
  readMigrationSql,
  registerPodcastFeed,
  seedTcgIdentityFixtures,
  user,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";

const TOKEN = "local-whisper-test-token-0123456789abcdef";
const ENV = { NODE_ENV: "test", LOCAL_TRANSCRIBER_TOKEN: TOKEN };

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  await db.insert(user).values({ id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true });
  const feed = await registerPodcastFeed(db, {
    feedUrl: "https://feeds.example.com/show.xml",
    displayName: "Pack Talk",
    actorUserId: "user_admin",
    env: ENV,
  });
  const index = await loadCardNameIndex(db);
  await ingestPodcastEpisode(db, {
    feed: { sourceAccountId: feed.sourceAccountId, feedUrl: feed.feedUrl, displayName: "Pack Talk" },
    episode: {
      id: "ep-1",
      link: null,
      title: "Ep 1",
      publishedAt: new Date("2026-09-01T00:00:00Z"),
      author: null,
      html: null,
      text: "",
      textSource: "none",
      audio: { url: "https://media.example.com/ep1.mp3", type: "audio/mpeg", bytes: 1000 },
      durationSeconds: 600,
    },
    index,
  });
  return { db, app: createApiApp({ db, env: ENV }) };
}

const post = (app: ReturnType<typeof createApiApp>, path: string, body: unknown, token = TOKEN) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("local transcript API", () => {
  it("is not there without LOCAL_TRANSCRIBER_TOKEN and refuses a wrong token", async () => {
    const off = createApiApp({ db: {} as Database, env: { NODE_ENV: "test" } });
    expect((await post(off, "/internal/local-transcripts/claim", {})).status).toBe(404);
    const on = createApiApp({ db: {} as Database, env: ENV });
    expect((await post(on, "/internal/local-transcripts/claim", {}, "wrong-token")).status).toBe(401);
    const none = await on.request("/internal/local-transcripts/claim", { method: "POST" });
    expect(none.status).toBe(401);
  });

  it("claims a job, accepts its transcript once and refuses content it did not hand out", async () => {
    const { app } = await setup();
    const claimed = await post(app, "/internal/local-transcripts/claim", { limit: 3, worker: "DESKTOP" });
    expect(claimed.status).toBe(200);
    const { jobs } = (await claimed.json()) as { jobs: Array<{ content_id: string; audio_url: string }> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.audio_url).toBe("https://media.example.com/ep1.mp3");

    const bad = await post(app, `/internal/local-transcripts/${jobs[0]!.content_id}`, { status: "ok", cues: "nope" });
    expect(bad.status).toBe(400);
    const body = { status: "ok", lang: "en", model: "large-v3-turbo", cues: [{ text: "i would buy charizard ex 006", start: 12, end: 15 }] };
    const done = await post(app, `/internal/local-transcripts/${jobs[0]!.content_id}`, body);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ outcome: "ingested", mentions: 1 });
    expect((await post(app, `/internal/local-transcripts/${jobs[0]!.content_id}`, body)).status).toBe(409);
    expect((await post(app, `/internal/local-transcripts/sct_${"0".repeat(32)}`, body)).status).toBe(409);
    expect((await post(app, "/internal/local-transcripts/not-an-id", body)).status).toBe(404);
  });

  it("hands out followed TikTok profiles and keeps the card videos the computer lists", async () => {
    const { db, app } = await setup();
    expect((await post(app, "/internal/local-transcripts/tiktok/claim", {}, "wrong-token-wrong-token-wrong-token-00")).status).toBe(401);
    const followed = await followTikTokCreator(db, { profile: "https://www.tiktok.com/@mitchy_stitchy", actorUserId: "user_admin" });
    const early = await post(app, `/internal/local-transcripts/tiktok/${followed.sourceAccountId}`, { status: "ok", videos: [] });
    expect(early.status).toBe(409);
    const claim = await post(app, "/internal/local-transcripts/tiktok/claim", { worker: "DESKTOP" });
    expect(claim.status).toBe(200);
    const { profiles } = (await claim.json()) as { profiles: Array<{ source_account_id: string; profile_url: string }> };
    expect(profiles).toMatchObject([{ source_account_id: followed.sourceAccountId, profile_url: "https://www.tiktok.com/@mitchy_stitchy" }]);
    const recent = Math.floor(Date.now() / 1000) - 3_600;
    const id = ((BigInt(recent) << 32n) | 5n).toString();
    const other = ((BigInt(recent - 60) << 32n) | 6n).toString();
    const sent = await post(app, `/internal/local-transcripts/tiktok/${followed.sourceAccountId}`, {
      status: "ok",
      tool: "yt-dlp",
      videos: [
        { id, caption: "Who agrees with the last one? #pokemon #pokemoncards", timestamp: recent, duration: 172 },
        { id: other, caption: "my dog says hi", timestamp: recent - 60 },
      ],
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ outcome: "listed", listed: 2, kept: 1, skipped: 1 });
    expect((await post(app, "/internal/local-transcripts/tiktok/not-an-id", { status: "ok", videos: [] })).status).toBe(404);
    expect((await post(app, `/internal/local-transcripts/tiktok/${followed.sourceAccountId}`, { status: "maybe" })).status).toBe(400);
  });
});
