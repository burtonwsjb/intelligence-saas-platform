import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  MAX_SOURCE_EXCERPT_CHARS,
  SourceValidationError,
  ingestSourceContentRecord,
  listSourceAccounts,
  listSourceContent,
  listSourceEngagement,
  listSourceMentions,
  listSourceSegments,
  readMigrationSql,
  receiveSourceContentRecord,
  normalizeSourceIntelligenceIngest,
  sourceIntelligenceFixtures,
  summarizeMentionVelocity,
  FixtureRedditSourceProvider,
  FixtureYoutubeSourceProvider,
  type Database,
} from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("source intelligence ingestion", () => {
  it("ingests YouTube and Reddit fixtures with idempotent accounts, segments, and unresolved mentions", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const fixtures = sourceIntelligenceFixtures();
    for (const record of fixtures) {
      const result = await ingestSourceContentRecord(db, record);
      expect(result.status).toBe("processed");
      expect(result.contentId).toBeTruthy();
    }
    const replay = await ingestSourceContentRecord(db, fixtures[0]!);
    expect(replay.status).toBe("duplicate");

    const contents = await listSourceContent(db);
    expect(contents.some((row) => row.sourceType === "youtube" && row.language === "en")).toBe(true);
    expect(contents.some((row) => row.sourceType === "youtube" && row.language === "ja")).toBe(true);
    expect(contents.some((row) => row.sourceType === "reddit")).toBe(true);
    expect(contents.every((row) => (row.excerpt?.length ?? 0) <= MAX_SOURCE_EXCERPT_CHARS)).toBe(true);
    expect(contents.filter((row) => row.externalContentId === "yt_vid_en_greninja")).toHaveLength(1);

    const accounts = await listSourceAccounts(db);
    expect(accounts.filter((row) => row.externalAccountId === "yt_ch_alpha")).toHaveLength(1);

    const yt = contents.find((row) => row.externalContentId === "yt_vid_en_greninja")!;
    const segments = await listSourceSegments(db, yt.id);
    expect(segments.some((row) => row.kind === "timestamp_range")).toBe(true);
    const mentions = await listSourceMentions(db, yt.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.metadata).toMatchObject({ resolution_status: "unresolved" });
    expect(mentions[0]?.normalizedEntityText).toBe("Greninja 214");
    const engagement = await listSourceEngagement(db, yt.id);
    expect(engagement[0]?.views).toBe(12000);
    expect(yt.publishedAt.toISOString()).toBe("2026-01-02T12:00:00.000Z");
    expect(yt.transcriptAvailable).toBe(true);

    const reddit = contents.find((row) => row.sourceType === "reddit")!;
    const redditMentions = await listSourceMentions(db, reddit.id);
    expect(redditMentions.length).toBeGreaterThan(1);
    expect(redditMentions.every((row) => row.metadata?.printing_id == null)).toBe(true);

    const velocity = summarizeMentionVelocity(
      (await listSourceMentions(db)).map((row) => ({
        contentId: row.contentId,
        createdAt: row.createdAt,
      })),
      7 * 86400,
    );
    expect(velocity.mention_count).toBeGreaterThan(0);
    expect(velocity.unique_content_count).toBeGreaterThan(1);

    await expect(
      ingestSourceContentRecord(db, {
        ...fixtures[0]!,
        content: { ...fixtures[0]!.content, title: "changed" },
      }),
    ).rejects.toBeInstanceOf(SourceValidationError);

    await expect(
      ingestSourceContentRecord(db, {
        ...fixtures[0]!,
        provider_record_id: "too_long_excerpt",
        content: {
          ...fixtures[0]!.content,
          external_content_id: "too_long_excerpt",
          excerpt: "x".repeat(MAX_SOURCE_EXCERPT_CHARS + 1),
        },
      }),
    ).rejects.toBeInstanceOf(SourceValidationError);

    const received = await receiveSourceContentRecord(db, {
      ...fixtures[2]!,
      provider_record_id: "rd_replay_worker",
      content: { ...fixtures[2]!.content, external_content_id: "rd_replay_worker" },
    });
    const first = await normalizeSourceIntelligenceIngest(db, received.ingestId);
    const second = await normalizeSourceIntelligenceIngest(db, received.ingestId);
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
  });

  it("uses in-memory YouTube and Reddit providers only", async () => {
    const youtube = new FixtureYoutubeSourceProvider();
    const reddit = new FixtureRedditSourceProvider();
    expect(await youtube.healthCheck()).toEqual({ ok: true, mode: "sandbox_fixture" });
    expect(await reddit.healthCheck()).toEqual({ ok: true, mode: "sandbox_fixture" });
    expect((await youtube.searchContent({ language: "en" }))[0]?.content.language).toBe("en");
    expect((await youtube.getTranscriptReference("yt_vid_en_greninja"))?.available).toBe(true);
    expect((await reddit.getPost("rd_post_en_greninja"))?.provider).toBe("reddit");
    const ytSrc = readFileSync(path.join(here, "provider.ts"), "utf8");
    expect(ytSrc).not.toMatch(/\bfetch\s*\(/);
    expect(ytSrc).not.toMatch(/https?:\/\/www\.youtube\.com\/youtubei/i);
    expect(ytSrc).not.toMatch(/oauth\.reddit\.com/i);
  });
});
