import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import { recordCreatorTrust } from "../creator/authority.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";
import { WebFeedClient } from "../providers/web-feed.js";
import { user } from "../schema/auth.js";
import { creatorCall } from "../schema/creator.js";
import { platformBreakGlassAudit } from "../schema/platform.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceAccount, sourceContent, sourceContentSegment } from "../schema/source.js";
import { TRANSCRIPT_EXTRACTOR_VERSION } from "./transcript-ingest.js";
import {
  LOCAL_TRANSCRIPT_MAX_ATTEMPTS,
  LocalTranscriptValidationError,
  claimLocalTranscriptJobs,
  localTranscriberToken,
  localTranscriptJobId,
  parseLocalTranscriptSubmission,
  submitLocalTranscript,
} from "./local-transcripts.js";
import {
  PodcastFeedError,
  listPodcastFeeds,
  normalizePodcastFeedUrl,
  podcastAccountId,
  registerPodcastFeed,
  runPodcastFeedSyncBatch,
  setPodcastFeedState,
  syncPodcastFeeds,
} from "./podcast-ingest.js";

const PODCAST = readFileSync(new URL("../providers/fixtures/web-feed/podcast.xml", import.meta.url), "utf8");
const ENV = { NODE_ENV: "test" };
const ADMIN = "user_admin";
const FEED = "https://feeds.example.com/packtalk.xml";
const NOW = new Date("2026-09-20T00:00:00Z");

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const catalog = await seedTcgIdentityFixtures(db);
  await db.insert(user).values({ id: ADMIN, name: "Admin", email: "admin@example.com", emailVerified: true });
  return { db, catalog };
}

function fakeWeb(routes: Record<string, HttpResponse>) {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async fetch(url) {
      calls.push(url);
      return routes[url] ?? { status: 404, headers: {}, bodyText: "" };
    },
  };
  const clientFor = () => new WebFeedClient({ transport, lookup: async () => ["93.184.216.34"], env: {}, maxRequests: 5 });
  return { calls, clientFor };
}

const FEED_ROUTES: Record<string, HttpResponse> = {
  "https://feeds.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
  [FEED]: { status: 200, headers: { "content-type": "application/rss+xml", etag: '"p1"' }, bodyText: PODCAST },
};

async function registeredAndRead() {
  const { db, catalog } = await setup();
  const podcast = await registerPodcastFeed(db, { feedUrl: FEED, displayName: "Pack Talk", actorUserId: ADMIN, env: ENV });
  const web = fakeWeb(FEED_ROUTES);
  const report = await runPodcastFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV, now: NOW });
  return { db, catalog, podcast, web, report };
}

describe("registerPodcastFeed", () => {
  it("registers a feed as an rss creator source with an audit row, idempotently", async () => {
    const { db } = await setup();
    const first = await registerPodcastFeed(db, { feedUrl: `${FEED}?utm_source=x#top`, actorUserId: ADMIN, env: ENV });
    expect(first.feedUrl).toBe(FEED);
    expect(first.sourceAccountId).toBe(podcastAccountId(FEED));
    const again = await registerPodcastFeed(db, { feedUrl: FEED, displayName: "Pack Talk", actorUserId: ADMIN, env: ENV });
    expect(again).toMatchObject({ sourceAccountId: first.sourceAccountId, creatorId: first.creatorId });
    const [account] = await db.select().from(sourceAccount).where(eq(sourceAccount.id, first.sourceAccountId));
    expect(account).toMatchObject({ sourceType: "rss", externalAccountId: FEED, displayName: "Pack Talk" });
    expect(account!.metadata).toMatchObject({ kind: "podcast", podcast_feed: { feed_url: FEED, state: "active" } });
    const audits = await db.select().from(platformBreakGlassAudit);
    expect(audits.map((row) => (row.metadata as Record<string, unknown>).change)).toEqual([
      "podcast_feed.register",
      "podcast_feed.register",
    ]);
  });

  it("refuses private and malformed feed URLs", () => {
    expect(() => normalizePodcastFeedUrl("http://127.0.0.1/feed.xml", ENV)).toThrow(PodcastFeedError);
    expect(() => normalizePodcastFeedUrl("", ENV)).toThrow(PodcastFeedError);
    expect(normalizePodcastFeedUrl("feeds.example.com/packtalk.xml", ENV)).toBe(FEED);
  });
});

describe("runPodcastFeedSyncBatch", () => {
  it("stores episodes from the last year with their audio, and show-note card names become calls", async () => {
    const { db, catalog, podcast, web, report } = await registeredAndRead();
    expect(report).toMatchObject({ status: "completed", feeds: 1, checked: 1, episodes: 2, newEpisodes: 2, callsCreated: 1 });
    expect(web.calls).toEqual(["https://feeds.example.com/robots.txt", FEED]);

    const episodes = await db.select().from(sourceContent).where(eq(sourceContent.accountId, podcast.sourceAccountId));
    // The 2024 episode is outside the 365-day window and the trailer has no audio.
    expect(episodes.map((row) => row.title).sort()).toEqual(["Ep 51: Mailbag", "Ep 52: Market check"]);
    const ep52 = episodes.find((row) => row.title === "Ep 52: Market check")!;
    expect(ep52).toMatchObject({ sourceType: "rss", contentType: "post", canonicalUrl: "https://media.example.com/packtalk/ep52.mp3?src=rss" });
    expect(ep52.metadata).toMatchObject({
      feed_provider: "podcast_feed",
      audio_url: "https://media.example.com/packtalk/ep52.mp3?src=rss",
      audio_type: "audio/mpeg",
      audio_bytes: 48123456,
      duration_seconds: 3725,
    });
    const ep51 = episodes.find((row) => row.title === "Ep 51: Mailbag")!;
    expect(ep51.canonicalUrl).toBe("https://packtalk.example.com/episodes/51");

    const calls = await db.select().from(creatorCall).where(eq(creatorCall.contentId, ep52.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ creatorId: podcast.creatorId, printingId: catalog.printings.charizardStandard.id, direction: "bullish" });

    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.trigger, "podcast_feed"));
    expect(run).toMatchObject({ providerKey: "web_feed", status: "completed", receivedCount: 2 });
    expect(run!.checkpoint).toMatchObject({ outcome: "read", feed_url: FEED, etag: '"p1"', episodes_new: 2 });
    expect(await listPodcastFeeds(db)).toMatchObject([{ displayName: "Pack Talk", episodes: 2, transcribed: 0, waiting: 2 }]);

    // Re-reading adds nothing, and a recently read feed is not requested again.
    const again = await runPodcastFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV, now: NOW, intervalHours: 0 });
    expect(again).toMatchObject({ checked: 1, newEpisodes: 0 });
    const notDue = await runPodcastFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV, now: NOW });
    expect(notDue).toMatchObject({ status: "skipped", reason: "nothing_due" });
  });

  it("skips paused feeds and stops before any request when the budget cannot cover a feed", async () => {
    const { db } = await setup();
    const podcast = await registerPodcastFeed(db, { feedUrl: FEED, actorUserId: ADMIN, env: ENV });
    const web = fakeWeb(FEED_ROUTES);
    const broke = await runPodcastFeedSyncBatch(db, { budget: 2, clientFor: web.clientFor, env: ENV, now: NOW });
    expect(broke).toMatchObject({ status: "stopped", reason: "budget_exhausted" });
    await setPodcastFeedState(db, { sourceAccountId: podcast.sourceAccountId, state: "paused", actorUserId: ADMIN });
    const paused = await runPodcastFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV, now: NOW });
    expect(paused).toMatchObject({ status: "skipped", reason: "nothing_due" });
    expect(web.calls).toEqual([]);
  });

  it("does nothing unless PROVIDER_WEB_FEED_MODE is live", async () => {
    const { db } = await setup();
    expect(await syncPodcastFeeds(db, { env: ENV })).toMatchObject({ status: "skipped" });
  });
});

const TRANSCRIPT = {
  status: "ok",
  lang: "en",
  model: "large-v3-turbo",
  cues: [
    { text: "welcome back to pack talk", start: 0, end: 4 },
    { text: "honestly i would buy charizard ex 006 from scarlet and violet", start: 1500.2, end: 1505 },
    { text: "it will go up in a month", start: 1505, end: 1508 },
  ],
};

describe("local transcription queue", () => {
  it("hands out episodes newest first and stores a Whisper transcript like a YouTube one", async () => {
    const { db, catalog, podcast } = await registeredAndRead();
    const [job] = await claimLocalTranscriptJobs(db, { limit: 1, worker: "DESKTOP-9NLIC16" });
    expect(job).toMatchObject({
      title: "Ep 52: Market check",
      audio_url: "https://media.example.com/packtalk/ep52.mp3?src=rss",
      duration_seconds: 3725,
      podcast: "Pack Talk",
    });
    // A claimed episode is not handed out twice.
    const [next] = await claimLocalTranscriptJobs(db, { limit: 5 });
    expect(next!.title).toBe("Ep 51: Mailbag");
    expect(await claimLocalTranscriptJobs(db, { limit: 5 })).toEqual([]);

    const report = await submitLocalTranscript(db, {
      contentId: job!.content_id,
      submission: parseLocalTranscriptSubmission(TRANSCRIPT),
    });
    expect(report).toMatchObject({ outcome: "ingested", segments: 1, mentions: 1 });
    const segments = await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, job!.content_id));
    const transcriptSegment = segments.find((row) => row.metadata.extractor_version === TRANSCRIPT_EXTRACTOR_VERSION)!;
    expect(transcriptSegment).toMatchObject({ kind: "timestamp_range", startRef: "t=1500" });
    expect(transcriptSegment.metadata).toMatchObject({ transcript_provider: "local_whisper", track_kind: "whisper" });
    expect(JSON.stringify(segments)).not.toContain("welcome back");
    const calls = await db.select().from(creatorCall).where(eq(creatorCall.contentId, job!.content_id));
    expect(calls.some((row) => row.segmentId === transcriptSegment.id && row.printingId === catalog.printings.charizardStandard.id)).toBe(true);

    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.id, localTranscriptJobId(job!.content_id)));
    expect(run).toMatchObject({ trigger: "local_transcript", status: "completed" });
    expect(run!.checkpoint).toMatchObject({ outcome: "ingested", model: "large-v3-turbo", worker: "DESKTOP-9NLIC16", attempts: 1 });

    // A finished job cannot be submitted again.
    expect((await submitLocalTranscript(db, { contentId: job!.content_id, submission: parseLocalTranscriptSubmission(TRANSCRIPT) })).outcome).toBe(
      "not_claimed",
    );
    expect(await listPodcastFeeds(db)).toMatchObject([{ sourceAccountId: podcast.sourceAccountId, transcribed: 1, waiting: 1 }]);
  });

  it("refuses unclaimed content, frees released jobs without an attempt, and gives up after repeated errors", async () => {
    const { db } = await registeredAndRead();
    const [episode] = await db.select().from(sourceContent).where(eq(sourceContent.title, "Ep 51: Mailbag"));
    const unclaimed = await submitLocalTranscript(db, { contentId: episode!.id, submission: parseLocalTranscriptSubmission(TRANSCRIPT) });
    expect(unclaimed.outcome).toBe("not_claimed");

    const claimAll = () => claimLocalTranscriptJobs(db, { limit: 5 });
    let jobs = await claimAll();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect((await submitLocalTranscript(db, { contentId: job.content_id, submission: { status: "release" } })).outcome).toBe("released");
    }
    jobs = await claimAll();
    expect(jobs).toHaveLength(2);
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.id, localTranscriptJobId(jobs[0]!.content_id)));
    expect(run!.checkpoint).toMatchObject({ attempts: 1 });

    // One episode's audio is gone: final. The other keeps failing: retried up to the limit.
    const [gone, flaky] = jobs;
    await submitLocalTranscript(db, { contentId: gone!.content_id, submission: { status: "unavailable", reason: "http_404" } });
    for (let attempt = 1; attempt <= LOCAL_TRANSCRIPT_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) expect((await claimAll()).map((job) => job.content_id)).toEqual([flaky!.content_id]);
      await submitLocalTranscript(db, { contentId: flaky!.content_id, submission: { status: "error", reason: "decode_failed" } });
    }
    expect(await claimAll()).toEqual([]);
  });

  it("skips episodes of paused podcasts and excluded creators", async () => {
    const { db, podcast } = await registeredAndRead();
    await setPodcastFeedState(db, { sourceAccountId: podcast.sourceAccountId, state: "paused", actorUserId: ADMIN });
    expect(await claimLocalTranscriptJobs(db, { limit: 5 })).toEqual([]);
    await setPodcastFeedState(db, { sourceAccountId: podcast.sourceAccountId, state: "active", actorUserId: ADMIN });
    await recordCreatorTrust(db, { creatorId: podcast.creatorId, trustState: "excluded", reason: "test" });
    expect(await claimLocalTranscriptJobs(db, { limit: 5 })).toEqual([]);
  });

  it("validates submissions and the token", () => {
    expect(() => parseLocalTranscriptSubmission({ status: "done" })).toThrow(LocalTranscriptValidationError);
    expect(() => parseLocalTranscriptSubmission({ status: "ok", cues: [{ text: "x", start: -1 }] })).toThrow(LocalTranscriptValidationError);
    expect(() => parseLocalTranscriptSubmission({ status: "ok", lang: "english!", cues: [] })).toThrow(LocalTranscriptValidationError);
    expect(parseLocalTranscriptSubmission({ status: "ok", cues: [{ text: " a &amp; b ", offset_ms: 1200, duration_ms: 800 }, { text: "  ", start: 3 }] })).toEqual({
      status: "ok",
      lang: "en",
      model: null,
      cues: [{ text: "a & b", offsetMs: 1200, durationMs: 800 }],
    });
    expect(parseLocalTranscriptSubmission({ status: "error", reason: "Download failed: 500!" })).toEqual({
      status: "error",
      reason: "Download_failed__500_",
    });
    expect(localTranscriberToken({})).toBeNull();
    expect(localTranscriberToken({ LOCAL_TRANSCRIBER_TOKEN: "short" })).toBeNull();
    expect(localTranscriberToken({ LOCAL_TRANSCRIBER_TOKEN: "x".repeat(40) })).toBe("x".repeat(40));
  });
});
