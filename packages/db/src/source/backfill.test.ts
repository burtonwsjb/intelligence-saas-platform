import { describe, expect, it } from "vitest";
import { articleMetadata, parseSitemap, robotsSitemaps } from "../providers/web-feed.js";
import { POKEMON_INFLUENCER_SEEDS, planInfluencerSeed } from "../creator/seed.js";
import { rankLeaderboard } from "../creator/leaderboard.js";
import { buildCardNameIndex } from "./card-detect.js";
import { isSitePostUrl } from "./web-backfill.js";
import { planYoutubeVideoSegments, youtubeDescriptionText } from "./youtube-backfill.js";

const index = buildCardNameIndex({
  cards: [
    { name: "Charizard ex", gameKey: "pokemon" },
    { name: "Pikachu", gameKey: "pokemon" },
  ],
  sets: [{ key: "obf", name: "Obsidian Flames", gameKey: "pokemon" }],
});

describe("sitemaps", () => {
  it("reads Sitemap lines from robots.txt", () => {
    const robots = "User-agent: *\nDisallow: /cart\nSitemap: https://example.com/sitemap_index.xml # main\nsitemap: ftp://x/y\n";
    expect(robotsSitemaps(robots)).toEqual(["https://example.com/sitemap_index.xml"]);
  });

  it("parses a URL set and a sitemap index with lastmod", () => {
    const urlset = parseSitemap(
      `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/blog/charizard-ex-outlook</loc><lastmod>2026-05-01</lastmod></url>
        <url><loc>https://example.com/blog/old</loc></url>
      </urlset>`,
      "https://example.com/sitemap.xml",
    );
    expect(urlset?.kind).toBe("urlset");
    expect(urlset?.entries.map((entry) => entry.loc)).toEqual([
      "https://example.com/blog/charizard-ex-outlook",
      "https://example.com/blog/old",
    ]);
    expect(urlset?.entries[0]!.lastmod?.toISOString().slice(0, 10)).toBe("2026-05-01");
    expect(urlset?.entries[1]!.lastmod).toBeNull();

    const sitemapIndex = parseSitemap(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/post-sitemap.xml</loc><lastmod>2026-06-01T00:00:00Z</lastmod></sitemap>
      </sitemapindex>`,
    );
    expect(sitemapIndex).toMatchObject({ kind: "index", entries: [{ loc: "https://example.com/post-sitemap.xml" }] });
    expect(parseSitemap("<rss><channel /></rss>")).toBeNull();
  });

  it("keeps post URLs of the registered site and path only", () => {
    const site = { domain: "example.com", siteUrl: "https://example.com/blog" };
    expect(isSitePostUrl("https://www.example.com/blog/my-post", site)).toBe(true);
    expect(isSitePostUrl("https://example.com/blog", site)).toBe(false);
    expect(isSitePostUrl("https://example.com/blog/tag/charizard", site)).toBe(false);
    expect(isSitePostUrl("https://example.com/shop/booster-box", site)).toBe(false);
    expect(isSitePostUrl("https://other.com/blog/my-post", site)).toBe(false);
    expect(isSitePostUrl("https://example.com/blog/cover.png", site)).toBe(false);
  });
});

describe("articleMetadata", () => {
  it("reads the publication time, never the modified time", () => {
    const page = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Charizard ex outlook">
      <meta property="article:modified_time" content="2026-07-01T00:00:00Z">
      <meta property="article:published_time" content="2026-03-04T10:00:00Z"></head><body></body></html>`;
    const meta = articleMetadata(page);
    expect(meta.title).toBe("Charizard ex outlook");
    expect(meta.publishedAt?.toISOString()).toBe("2026-03-04T10:00:00.000Z");
  });

  it("falls back to JSON-LD and reports undated pages", () => {
    const ld = `<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-02-01T08:00:00Z"}</script>`;
    expect(articleMetadata(ld).publishedAt?.toISOString()).toBe("2026-02-01T08:00:00.000Z");
    const modifiedOnly = `<meta property="article:modified_time" content="2026-07-01T00:00:00Z"><title>Post</title>`;
    expect(articleMetadata(modifiedOnly)).toEqual({ title: "Post", publishedAt: null });
  });
});

describe("YouTube description card detection", () => {
  it("drops links and reads each description line", () => {
    expect(youtubeDescriptionText("a\n\nhttps://x.example/z\nwww.foo.com b")).toBe("a\n\nb");
  });

  it("names specific cards from the title and description in bounded segments", () => {
    const segments = planYoutubeVideoSegments(
      "content_1",
      "Is Charizard ex 199 about to explode?",
      "My thoughts on the market.\nShop: https://shop.example/pikachu\nI am buying Pikachu before it moves.",
      index,
    );
    // Body text comes before the title, as for website posts.
    const names = segments.flatMap((segment) => segment.mentions.map((mention) => mention.hints.card_name));
    expect(names).toEqual(["Pikachu", "Charizard ex"]);
    expect(segments.every((segment) => segment.metadata.source === "youtube_description")).toBe(true);
    expect(segments.some((segment) => segment.excerpt.includes("shop.example"))).toBe(false);
    expect(segments.every((segment) => segment.excerpt.length <= 480)).toBe(true);
  });
});

describe("influencer seed plan", () => {
  it("looks up only real channel ids and handles and never registers shared platforms", () => {
    const plan = planInfluencerSeed(POKEMON_INFLUENCER_SEEDS);
    expect(plan.channels).toHaveLength(POKEMON_INFLUENCER_SEEDS.length);
    const lookups = plan.channels.filter((channel) => channel.input);
    expect(lookups.map((channel) => [channel.rank, channel.input])).toEqual([
      [2, "@dannyphantump"],
      [3, "UCUHYM7gs-GZpRGEsskTEqzQ"],
    ]);
    expect(plan.channels.find((channel) => channel.rank === 39)?.skip).toBe("custom_url");
    expect(plan.channels.find((channel) => channel.rank === 1)?.skip).toBe("no_handle");

    expect(plan.sites.find((site) => site.rank === 6)?.skip).toBe("shared_platform");
    const substack = plan.sites.filter((site) => site.rank === 26);
    expect(substack).toEqual([
      expect.objectContaining({ domain: "pokerad.substack.com", feedUrl: "https://pokerad.substack.com/feed", skip: null }),
    ]);
  });
});

describe("leaderboard ranking", () => {
  const row = (creatorId: string, callsEvaluated: number, cameTrue: number) => ({
    creatorId,
    name: creatorId,
    platforms: ["youtube"],
    callsMade: callsEvaluated + 2,
    callsEvaluated,
    cameTrue,
    authorityWeight: null,
    trustState: null,
    lastCallAt: null,
  });

  it("ranks on the accuracy lower bound and holds back short records", () => {
    const { ranked, notEnoughCalls } = rankLeaderboard([row("lucky", 5, 5), row("steady", 50, 40), row("new", 2, 2)], 5);
    expect(ranked.map((entry) => [entry.rank, entry.creatorId])).toEqual([
      [1, "steady"],
      [2, "lucky"],
    ]);
    expect(ranked[1]!.accuracy).toBe(1);
    expect(notEnoughCalls).toEqual([expect.objectContaining({ creatorId: "new", rank: null, accuracy: 1 })]);
  });
});
