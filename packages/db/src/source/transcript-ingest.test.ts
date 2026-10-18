import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  ensureCreatorForSourceAccount,
  ingestSourceContentRecord,
  readMigrationSql,
  seedTcgIdentityFixtures,
  type Database,
} from "../index.js";
import { recordCreatorTrust } from "../creator/authority.js";
import type { TranscriptCue, TranscriptFetcher, TranscriptResult } from "../providers/transcripts.js";
import { chunkTranscriptCues } from "../providers/transcripts.js";
import { creatorCall } from "../schema/creator.js";
import { providerSyncRun } from "../schema/provider.js";
import { entityResolutionAttempt } from "../schema/resolution.js";
import { sourceContent, sourceContentSegment, sourceMention } from "../schema/source.js";
import { loadCardNameIndex } from "./card-detect.js";
import type { SourceContentRecordInput } from "./identity.js";
import {
  TRANSCRIPT_EXCERPT_MAX_CHARS,
  boundedWindowExcerpt,
  ingestTranscriptForContent,
  planTranscriptSegments,
  runTranscriptBackfillBatch,
  transcriptCheckId,
} from "./transcript-ingest.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const catalog = await seedTcgIdentityFixtures(db);
  return { db, catalog };
}

function video(id: string, publishedAt: string, channel = "UCchannel"): SourceContentRecordInput {
  return {
    provider: "youtube",
    provider_record_id: id,
    event_type: "source.content.ingested",
    account: { external_account_id: channel, handle: channel, display_name: channel },
    content: {
      external_content_id: id,
      content_type: "video",
      published_at: publishedAt,
      title: "The Pokemon Market Is CRASHING!",
      canonical_url: `https://www.youtube.com/watch?v=${id}`,
      license_status: "reference_only",
      retention_policy: "reference_only",
    },
    mentions: [{ raw_entity_text: "The Pokemon Market Is CRASHING!" }],
  };
}

const CUES: TranscriptCue[] = [
  { text: "what is going on everybody the pokemon market is crashing today", offsetMs: 1_000, durationMs: 5_000 },
  { text: "but honestly i would buy charizard ex 006 from scarlet and violet", offsetMs: 72_000, durationMs: 5_000 },
  { text: "it will go up in a month", offsetMs: 77_000, durationMs: 3_000 },
  { text: "thanks for watching see you next time", offsetMs: 140_000, durationMs: 3_000 },
];

function fakeFetcher(results: TranscriptResult[] | ((videoId: string) => TranscriptResult)) {
  const calls: string[] = [];
  const fetcher: TranscriptFetcher = {
    provider: "youtube_captions",
    maxRequestsPerVideo: 2,
    async fetch(videoId) {
      calls.push(videoId);
      if (typeof results === "function") return results(videoId);
      const next = results.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  };
  return { fetcher, calls };
}

const OK: TranscriptResult = { status: "ok", lang: "en", trackKind: "asr", cues: CUES };

async function contentId(db: Database, externalId: string) {
  const [row] = await db.select().from(sourceContent).where(eq(sourceContent.externalContentId, externalId));
  return row!.id;
}

describe("ingestTranscriptForContent", () => {
  it("stores only the windows naming a card, resolves the card and creates a call bound to the printing", async () => {
    const { db, catalog } = await setup();
    await ingestSourceContentRecord(db, video("AbCdEfGhIj0", "2026-09-01T00:00:00Z"));
    const id = await contentId(db, "AbCdEfGhIj0");
    const { fetcher, calls } = fakeFetcher([OK]);

    const report = await ingestTranscriptForContent(db, id, fetcher);
    expect(calls).toEqual(["AbCdEfGhIj0"]);
    expect(report).toMatchObject({ outcome: "ingested", windows: 3, segments: 1, mentions: 1, callsCreated: 1 });

    const segments = await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, id));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "timestamp_range", startRef: "t=72", endRef: "t=80" });
    expect(segments[0]!.metadata).toMatchObject({ source: "transcript", transcript_provider: "youtube_captions" });
    expect(segments[0]!.excerpt!.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_MAX_CHARS);
    expect(segments[0]!.excerpt).toContain("charizard ex 006 from scarlet and violet");
    // Windows without a card name are never stored.
    expect(JSON.stringify(segments)).not.toContain("thanks for watching");
    expect(JSON.stringify(segments)).not.toContain("what is going on");

    const mentions = await db.select().from(sourceMention).where(eq(sourceMention.contentId, id));
    const transcriptMention = mentions.find((row) => row.segmentId === segments[0]!.id)!;
    expect(transcriptMention.rawEntityText).toBe("Charizard ex 006");
    expect(transcriptMention.metadata).toMatchObject({
      transcript: { card_name: "Charizard ex", collector_number: "006", set_key: "sv1", game_key: "pokemon", offset_ms: 72_000 },
    });

    const [attempt] = await db
      .select()
      .from(entityResolutionAttempt)
      .where(eq(entityResolutionAttempt.mentionId, transcriptMention.id));
    expect(attempt).toMatchObject({ status: "exact", chosenPrintingId: catalog.printings.charizardStandard.id });

    const created = await db.select().from(creatorCall).where(eq(creatorCall.contentId, id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      mentionId: transcriptMention.id,
      segmentId: segments[0]!.id,
      printingId: catalog.printings.charizardStandard.id,
      direction: "bullish",
    });

    const [check] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.id, transcriptCheckId(id)));
    expect(check).toMatchObject({ providerKey: "youtube", trigger: "transcript", status: "completed", limitCount: 2 });
    expect(check!.checkpoint).toMatchObject({ outcome: "ingested", transcript_available: true, attempts: 1, segments: 1 });

    // Re-running is a no-op: the video is not fetched again and nothing is added.
    const again = await ingestTranscriptForContent(db, id, fetcher);
    expect(again.outcome).toBe("already_checked");
    expect(calls).toHaveLength(1);
    expect(await db.select().from(creatorCall).where(eq(creatorCall.contentId, id))).toHaveLength(1);
  });

  it("plans the same stable segment and mention ids every time", async () => {
    const { db } = await setup();
    const index = await loadCardNameIndex(db);
    const windows = chunkTranscriptCues(CUES);
    const first = planTranscriptSegments("sct_x", windows, index);
    const second = planTranscriptSegments("sct_x", windows, index);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.mentions.map((row) => row.rawEntityText)).toEqual(["Charizard ex 006"]);
  });

  it("records an unavailable transcript as checked and never fetches it again", async () => {
    const { db } = await setup();
    await ingestSourceContentRecord(db, video("NoCaptions1", "2026-09-01T00:00:00Z"));
    const id = await contentId(db, "NoCaptions1");
    const { fetcher, calls } = fakeFetcher([{ status: "unavailable", reason: "no_captions" }]);
    expect((await ingestTranscriptForContent(db, id, fetcher)).outcome).toBe("unavailable");
    const [check] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.id, transcriptCheckId(id)));
    expect(check).toMatchObject({ status: "skipped" });
    expect(check!.checkpoint).toMatchObject({ outcome: "unavailable", transcript_available: false });
    expect(await runTranscriptBackfillBatch(db, fetcher, { budget: 50 })).toMatchObject({
      status: "skipped",
      reason: "nothing_to_check",
    });
    expect(calls).toHaveLength(1);
    expect(await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, id))).toEqual([]);
  });

  it("skips content that is not a YouTube video", async () => {
    const { db } = await setup();
    const record = video("RedditPost1", "2026-09-01T00:00:00Z");
    await ingestSourceContentRecord(db, {
      ...record,
      provider: "reddit",
      content: { ...record.content, content_type: "post", canonical_url: "https://www.reddit.com/r/x/1" },
    });
    const id = await contentId(db, "RedditPost1");
    const { fetcher, calls } = fakeFetcher([]);
    expect((await ingestTranscriptForContent(db, id, fetcher)).outcome).toBe("not_eligible");
    expect(calls).toEqual([]);
  });
});

describe("runTranscriptBackfillBatch", () => {
  it("checks the newest videos first within the daily budget", async () => {
    const { db } = await setup();
    await ingestSourceContentRecord(db, video("OlderVideo1", "2026-08-01T00:00:00Z"));
    await ingestSourceContentRecord(db, video("NewerVideo1", "2026-09-01T00:00:00Z"));
    await ingestSourceContentRecord(db, video("NewestVide1", "2026-09-02T00:00:00Z"));
    const { fetcher, calls } = fakeFetcher(() => ({ status: "unavailable" }));

    // Two requests per video: a budget of 5 allows two videos today.
    const first = await runTranscriptBackfillBatch(db, fetcher, { budget: 5 });
    expect(calls).toEqual(["NewestVide1", "NewerVideo1"]);
    expect(first).toMatchObject({ status: "stopped", reason: "budget_exhausted", checked: 2, unavailable: 2 });
    const second = await runTranscriptBackfillBatch(db, fetcher, { budget: 5 });
    expect(second).toMatchObject({ status: "stopped", reason: "budget_exhausted", checked: 0 });
    expect(calls).toHaveLength(2);
    expect(await runTranscriptBackfillBatch(db, fetcher, { budget: 1 })).toMatchObject({
      status: "skipped",
      reason: "no_budget",
    });
  });

  it("stops for the day once the provider blocks a request", async () => {
    const { db } = await setup();
    await ingestSourceContentRecord(db, video("BlockedOne1", "2026-09-02T00:00:00Z"));
    await ingestSourceContentRecord(db, video("BlockedTwo1", "2026-09-01T00:00:00Z"));
    const { fetcher, calls } = fakeFetcher(() => ({ status: "rate_limited", reason: "blocked" }));
    expect(await runTranscriptBackfillBatch(db, fetcher, { budget: 50 })).toMatchObject({
      status: "stopped",
      reason: "blocked",
      failed: 1,
    });
    expect(calls).toEqual(["BlockedOne1"]);
    expect(await runTranscriptBackfillBatch(db, fetcher, { budget: 50 })).toMatchObject({
      status: "skipped",
      reason: "blocked_today",
    });
    expect(calls).toHaveLength(1);
    const [check] = await db
      .select()
      .from(providerSyncRun)
      .where(eq(providerSyncRun.id, transcriptCheckId(await contentId(db, "BlockedOne1"))));
    expect(check).toMatchObject({ status: "failed", errorClass: "blocked" });
  });

  it("skips videos from creators an operator excluded", async () => {
    const { db } = await setup();
    await ingestSourceContentRecord(db, video("Excluded001", "2026-09-02T00:00:00Z", "UCexcluded"));
    const [content] = await db.select().from(sourceContent).where(eq(sourceContent.externalContentId, "Excluded001"));
    const { creator } = await ensureCreatorForSourceAccount(db, content!.accountId);
    await recordCreatorTrust(db, { creatorId: creator.id, trustState: "excluded", reason: "test" });
    const { fetcher, calls } = fakeFetcher(() => OK);
    expect(await runTranscriptBackfillBatch(db, fetcher, { budget: 50 })).toMatchObject({
      status: "skipped",
      reason: "nothing_to_check",
    });
    expect(calls).toEqual([]);
  });
});

describe("boundedWindowExcerpt", () => {
  it("keeps text around each mention, merged, within the limit", () => {
    const text = `${"a ".repeat(300)}charizard ex 006 ${"b ".repeat(300)}pikachu ${"c ".repeat(300)}`;
    const first = text.indexOf("charizard");
    const second = text.indexOf("pikachu");
    const excerpt = boundedWindowExcerpt(text, [
      { start: first, end: first + 12 },
      { start: second, end: second + 7 },
    ]);
    expect(excerpt.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_MAX_CHARS);
    expect(excerpt).toContain("charizard ex 006");
    expect(excerpt).toContain(" … ");
    expect(excerpt).toContain("pikachu");
  });
});
