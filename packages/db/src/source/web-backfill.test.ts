import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";
import { WebFeedClient } from "../providers/web-feed.js";
import { user } from "../schema/auth.js";
import { providerSyncRun } from "../schema/provider.js";
import { sourceContent, sourceMention } from "../schema/source.js";
import { WEB_BACKFILL_TRIGGER, listWebBackfillProgress, runWebBackfillBatch } from "./web-backfill.js";
import { registerWebFeedSite } from "./web-feed-ingest.js";

const ENV = { NODE_ENV: "test" };
const ADMIN = "user_admin";
const SITE = "https://cards.example.com";

const ok = (bodyText: string, contentType: string): HttpResponse => ({ status: 200, headers: { "content-type": contentType }, bodyText });

const ROUTES: Record<string, HttpResponse> = {
  [`${SITE}/robots.txt`]: ok(
    `User-agent: *\nDisallow: /private/\nSitemap: ${SITE}/sitemap_index.xml\nSitemap: https://elsewhere.example.net/sitemap.xml\n`,
    "text/plain",
  ),
  [`${SITE}/sitemap_index.xml`]: ok(
    `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>${SITE}/post-sitemap.xml</loc><lastmod>2026-05-02T00:00:00Z</lastmod></sitemap>
      <sitemap><loc>${SITE}/old-sitemap.xml</loc><lastmod>2023-01-01T00:00:00Z</lastmod></sitemap>
    </sitemapindex>`,
    "application/xml",
  ),
  [`${SITE}/post-sitemap.xml`]: ok(
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${SITE}/charizard-outlook/</loc><lastmod>2026-05-01T00:00:00Z</lastmod></url>
      <url><loc>${SITE}/private/members-only/</loc><lastmod>2026-04-01T00:00:00Z</lastmod></url>
      <url><loc>${SITE}/tag/charizard/</loc><lastmod>2026-05-01T00:00:00Z</lastmod></url>
      <url><loc>${SITE}/old-post/</loc><lastmod>2024-01-01T00:00:00Z</lastmod></url>
      <url><loc>${SITE}/undated/</loc></url>
    </urlset>`,
    "application/xml",
  ),
  [`${SITE}/charizard-outlook/`]: ok(
    `<html><head><title>Market outlook</title>
      <meta property="article:published_time" content="2026-04-30T10:00:00Z"></head>
      <body><article><h1>Market outlook</h1>
      <p>I would buy Charizard ex 006 from Scarlet &amp; Violet before it goes up.</p></article></body></html>`,
    "text/html",
  ),
  [`${SITE}/undated/`]: ok(`<html><head><title>Undated</title></head><body><p>Charizard ex 006 talk.</p></body></html>`, "text/html"),
};

function fakeWeb() {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async fetch(url) {
      calls.push(url);
      return ROUTES[url] ?? { status: 404, headers: {}, bodyText: "" };
    },
  };
  const clientFor = () => new WebFeedClient({ transport, lookup: async () => ["93.184.216.34"], env: {} });
  return { calls, clientFor };
}

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  await db.insert(user).values({ id: ADMIN, name: "Admin", email: "admin@example.com", emailVerified: true });
  return db;
}

describe("website sitemap backfill", () => {
  it("finds last year's posts through robots.txt and sitemaps, reads only dated posts robots.txt allows, and finishes", async () => {
    const db = await setup();
    const site = await registerWebFeedSite(db, { siteUrl: `${SITE}/`, actorUserId: ADMIN, env: ENV });
    const web = fakeWeb();
    const now = new Date("2026-06-01T00:00:00Z");

    const report = await runWebBackfillBatch(db, { budget: 50, perSiteDay: 30, days: 365, clientFor: web.clientFor, now, env: ENV });
    expect(report).toMatchObject({ status: "completed", sites: 1, finished: 1, sitemaps: 2, pages: 2, posts: 1, mentions: 1 });
    // The other host's sitemap, the old sitemap, the tag page, the old post and the disallowed post are never requested.
    expect(web.calls).toEqual([
      `${SITE}/robots.txt`,
      `${SITE}/sitemap_index.xml`,
      `${SITE}/post-sitemap.xml`,
      `${SITE}/charizard-outlook/`,
      `${SITE}/undated/`,
    ]);

    const contents = await db.select().from(sourceContent).where(eq(sourceContent.accountId, site.sourceAccountId));
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ title: "Market outlook", summary: null, excerpt: null });
    expect(contents[0]!.publishedAt.toISOString()).toBe("2026-04-30T10:00:00.000Z");
    expect(contents[0]!.metadata).toMatchObject({ published_at_source: "article_metadata", discovered_via: "sitemap" });
    const mentions = await db.select().from(sourceMention).where(eq(sourceMention.contentId, contents[0]!.id));
    expect(mentions.map((row) => row.rawEntityText)).toEqual(["Charizard ex 006"]);

    const runs = await db
      .select()
      .from(providerSyncRun)
      .where(and(eq(providerSyncRun.providerKey, "web_feed"), eq(providerSyncRun.trigger, WEB_BACKFILL_TRIGGER)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", limitCount: 5, receivedCount: 1 });
    expect(runs[0]!.checkpoint).toMatchObject({
      account_id: site.sourceAccountId,
      phase: "done",
      outcome: "complete",
      urls: [],
      urls_total: 3,
      posts_ingested: 1,
      posts_undated: 1,
      posts_blocked: 1,
      posts_old: 0,
    });
    expect(await listWebBackfillProgress(db)).toMatchObject([{ sourceAccountId: site.sourceAccountId, phase: "done", postsIngested: 1 }]);

    // A finished site is not read again.
    const again = await runWebBackfillBatch(db, { budget: 50, perSiteDay: 30, days: 365, clientFor: web.clientFor, now, env: ENV });
    expect(again).toMatchObject({ status: "skipped", reason: "nothing_to_backfill" });
    expect(web.calls).toHaveLength(5);
  });
});
