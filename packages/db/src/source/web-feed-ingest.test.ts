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
import { creatorCall, creatorSourceAccount } from "../schema/creator.js";
import { platformBreakGlassAudit } from "../schema/platform.js";
import { providerSyncRun } from "../schema/provider.js";
import { entityResolutionAttempt } from "../schema/resolution.js";
import { sourceAccount, sourceContent, sourceContentSegment, sourceMention } from "../schema/source.js";
import { CARD_MENTION_EXCERPT_MAX_CHARS } from "./card-mentions.js";
import {
  WebFeedSiteError,
  listWebFeedSites,
  registerWebFeedSite,
  runWebFeedSyncBatch,
  setWebFeedSiteState,
  syncWebFeeds,
  webFeedAccountId,
} from "./web-feed-ingest.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../providers/fixtures/web-feed/${name}`, import.meta.url), "utf8");
const RSS = fixture("rss.xml");
const HOMEPAGE = fixture("homepage.html");
const ROBOTS = fixture("robots.txt");
const ENV = { NODE_ENV: "test" };
const ADMIN = "user_admin";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const catalog = await seedTcgIdentityFixtures(db);
  await db.insert(user).values({ id: ADMIN, name: "Admin", email: "admin@example.com", emailVerified: true });
  return { db, catalog };
}

type Route = HttpResponse | ((headers: Record<string, string>) => HttpResponse);

function fakeWeb(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: HttpTransport = {
    async fetch(url, init) {
      const headers = init?.headers ?? {};
      calls.push({ url, headers });
      const route = routes[url];
      if (!route) return { status: 404, headers: {}, bodyText: "" };
      return typeof route === "function" ? route(headers) : route;
    },
  };
  const clientFor = () => new WebFeedClient({ transport, lookup: async () => ["93.184.216.34"], env: {} });
  return { calls, clientFor };
}

const ok = (bodyText: string, contentType: string, extra: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  headers: { "content-type": contentType, ...extra },
  bodyText,
});

const CARDS_SITE: Record<string, Route> = {
  "https://cards.example.com/robots.txt": ok(ROBOTS, "text/plain"),
  "https://cards.example.com/": ok(HOMEPAGE, "text/html"),
  "https://cards.example.com/feed/": (headers) =>
    headers["if-none-match"] === '"v1"'
      ? { status: 304, headers: {}, bodyText: "" }
      : ok(RSS, "application/rss+xml", { etag: '"v1"' }),
};

describe("registerWebFeedSite", () => {
  it("registers a website as a creator source with an audit row, idempotently", async () => {
    const { db } = await setup();
    const first = await registerWebFeedSite(db, {
      siteUrl: "cards.example.com",
      displayName: "Card Insider",
      actorUserId: ADMIN,
      env: ENV,
    });
    expect(first).toMatchObject({ domain: "cards.example.com", siteUrl: "https://cards.example.com/", feedUrl: null });
    expect(first.sourceAccountId).toBe(webFeedAccountId("cards.example.com"));
    const [account] = await db.select().from(sourceAccount).where(eq(sourceAccount.id, first.sourceAccountId));
    expect(account).toMatchObject({ sourceType: "web", externalAccountId: "cards.example.com", displayName: "Card Insider" });
    expect(account!.metadata).toMatchObject({
      kind: "website",
      web_feed: { site_url: "https://cards.example.com/", state: "active", registered_by: ADMIN },
    });
    const [link] = await db
      .select()
      .from(creatorSourceAccount)
      .where(eq(creatorSourceAccount.sourceAccountId, first.sourceAccountId));
    expect(link!.creatorId).toBe(first.creatorId);
    const audits = await db.select().from(platformBreakGlassAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "discovery.monitor", targetType: "source_account", targetId: first.sourceAccountId });

    const again = await registerWebFeedSite(db, { siteUrl: "https://www.cards.example.com/", actorUserId: ADMIN, env: ENV });
    expect(again.sourceAccountId).toBe(first.sourceAccountId);
    expect(again.creatorId).toBe(first.creatorId);
    const [after] = await db.select().from(sourceAccount).where(eq(sourceAccount.id, first.sourceAccountId));
    expect((after!.metadata.web_feed as Record<string, unknown>).registered_at).toBe(
      (account!.metadata.web_feed as Record<string, unknown>).registered_at,
    );
    expect(await listWebFeedSites(db)).toMatchObject([{ domain: "cards.example.com", state: "active", lastCheckAt: null }]);
  });

  it("refuses platforms, stores and private addresses", async () => {
    const { db } = await setup();
    for (const [siteUrl, code] of [
      ["https://www.youtube.com/@creator", "platform_site"],
      ["https://www.ebay.com/", "platform_site"],
      ["http://localhost:3000/", "invalid_url"],
      ["http://10.0.0.8/feed", "invalid_url"],
      ["", "invalid_url"],
    ] as const) {
      const error = await registerWebFeedSite(db, { siteUrl, actorUserId: ADMIN, env: ENV }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WebFeedSiteError);
      expect((error as WebFeedSiteError).code).toBe(code);
    }
    expect(await db.select().from(platformBreakGlassAudit)).toEqual([]);
  });
});

describe("runWebFeedSyncBatch", () => {
  it("turns a post naming a card into a segment, a resolved mention and a creator call", async () => {
    const { db, catalog } = await setup();
    const site = await registerWebFeedSite(db, { siteUrl: "https://cards.example.com/", actorUserId: ADMIN, env: ENV });
    const web = fakeWeb(CARDS_SITE);

    const report = await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV });
    expect(report).toMatchObject({ status: "completed", sites: 1, checked: 1, posts: 2, newPosts: 2, mentions: 1, callsCreated: 1 });
    expect(web.calls.map((call) => call.url)).toEqual([
      "https://cards.example.com/robots.txt",
      "https://cards.example.com/",
      "https://cards.example.com/feed/",
    ]);

    const contents = await db.select().from(sourceContent).where(eq(sourceContent.accountId, site.sourceAccountId));
    expect(contents).toHaveLength(2);
    const post = contents.find((row) => row.title === "Three cards I’m buying this month")!;
    expect(post).toMatchObject({
      sourceType: "web",
      contentType: "article",
      canonicalUrl: "https://cards.example.com/2026/09/three-cards/",
      summary: null,
      excerpt: null,
    });
    expect(post.publishedAt.toISOString()).toBe("2026-09-01T14:00:00.000Z");
    expect(post.metadata).toMatchObject({ feed_provider: "web_feed", feed_url: "https://cards.example.com/feed/" });

    const segments = await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, post.id));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "paragraph", startRef: "p=1" });
    expect(segments[0]!.excerpt!.length).toBeLessThanOrEqual(CARD_MENTION_EXCERPT_MAX_CHARS);
    expect(segments[0]!.excerpt).toContain("I would buy Charizard ex 006 from Scarlet & Violet");
    expect(JSON.stringify(segments)).not.toContain("alert");
    const other = contents.find((row) => row.id !== post.id)!;
    expect(await db.select().from(sourceContentSegment).where(eq(sourceContentSegment.contentId, other.id))).toEqual([]);

    const mentions = await db.select().from(sourceMention).where(eq(sourceMention.contentId, post.id));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ rawEntityText: "Charizard ex 006", segmentId: segments[0]!.id });
    expect(mentions[0]!.metadata).toMatchObject({
      card_detect: { source: "web_feed", card_name: "Charizard ex", collector_number: "006", set_key: "sv1", game_key: "pokemon" },
    });
    const [attempt] = await db
      .select()
      .from(entityResolutionAttempt)
      .where(eq(entityResolutionAttempt.mentionId, mentions[0]!.id));
    expect(attempt).toMatchObject({ status: "exact", chosenPrintingId: catalog.printings.charizardStandard.id });

    const calls = await db.select().from(creatorCall).where(eq(creatorCall.contentId, post.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      creatorId: site.creatorId,
      mentionId: mentions[0]!.id,
      printingId: catalog.printings.charizardStandard.id,
      direction: "bullish",
    });

    const runs = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "web_feed"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "web_feed", status: "completed", limitCount: 3, receivedCount: 2 });
    expect(runs[0]!.checkpoint).toMatchObject({
      account_id: site.sourceAccountId,
      outcome: "read",
      feed_url: "https://cards.example.com/feed/",
      etag: '"v1"',
      posts_new: 2,
      calls_created: 1,
    });
    expect(await listWebFeedSites(db)).toMatchObject([{ feedUrl: "https://cards.example.com/feed/", lastOutcome: "read", lastNewPosts: 2 }]);
  });

  it("is idempotent: a recent site is not read again, validators give not-modified, re-read posts add nothing", async () => {
    const { db } = await setup();
    const site = await registerWebFeedSite(db, { siteUrl: "https://cards.example.com/", actorUserId: ADMIN, env: ENV });
    const web = fakeWeb(CARDS_SITE);
    await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV });
    const callsAfterFirst = await db.select().from(creatorCall).where(eq(creatorCall.creatorId, site.creatorId));
    expect(callsAfterFirst).toHaveLength(1);

    // Within the interval nothing is due.
    expect(await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV })).toMatchObject({
      status: "skipped",
      reason: "nothing_due",
    });
    expect(web.calls).toHaveLength(3);

    // Due again: the stored ETag gives 304, so no posts are read.
    const second = await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV, intervalHours: 0 });
    expect(second).toMatchObject({ sites: 1, notModified: 1, posts: 0 });
    expect(web.calls.at(-1)!.headers["if-none-match"]).toBe('"v1"');

    // A feed without validators re-reads the same posts: nothing new is stored.
    const plain = fakeWeb({ ...CARDS_SITE, "https://cards.example.com/feed/": ok(RSS, "application/rss+xml") });
    const third = await runWebFeedSyncBatch(db, { budget: 50, clientFor: plain.clientFor, env: ENV, intervalHours: 0 });
    expect(third).toMatchObject({ checked: 1, posts: 2, newPosts: 0, mentions: 0, callsCreated: 0 });
    expect(await db.select().from(creatorCall).where(eq(creatorCall.creatorId, site.creatorId))).toHaveLength(1);
    expect(await db.select().from(sourceContent).where(eq(sourceContent.accountId, site.sourceAccountId))).toHaveLength(2);
  });

  it("skips a site whose robots.txt disallows the bot without requesting anything else", async () => {
    const { db } = await setup();
    const site = await registerWebFeedSite(db, { siteUrl: "https://closed.example.com/", actorUserId: ADMIN, env: ENV });
    const web = fakeWeb({
      "https://closed.example.com/robots.txt": ok("User-agent: SentimentBot\nDisallow: /\n", "text/plain"),
      "https://closed.example.com/feed": ok(RSS, "application/rss+xml"),
    });
    const report = await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV });
    expect(report).toMatchObject({ sites: 1, skipped: 1, posts: 0 });
    expect(web.calls.map((call) => call.url)).toEqual(["https://closed.example.com/robots.txt"]);
    expect(await db.select().from(sourceContent).where(eq(sourceContent.accountId, site.sourceAccountId))).toEqual([]);
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.providerKey, "web_feed"));
    expect(run).toMatchObject({ status: "skipped", errorClass: "robots", limitCount: 1 });
  });

  it("skips paused sites and sites of creators an operator excluded", async () => {
    const { db } = await setup();
    const paused = await registerWebFeedSite(db, { siteUrl: "https://cards.example.com/", actorUserId: ADMIN, env: ENV });
    await setWebFeedSiteState(db, { sourceAccountId: paused.sourceAccountId, state: "paused", actorUserId: ADMIN });
    const excluded = await registerWebFeedSite(db, { siteUrl: "https://excluded.example.com/", actorUserId: ADMIN, env: ENV });
    await recordCreatorTrust(db, { creatorId: excluded.creatorId, trustState: "excluded", reason: "test" });
    const web = fakeWeb(CARDS_SITE);
    expect(await runWebFeedSyncBatch(db, { budget: 50, clientFor: web.clientFor, env: ENV })).toMatchObject({
      status: "skipped",
      reason: "nothing_due",
    });
    expect(web.calls).toEqual([]);
  });

  it("stops before any request when the daily budget cannot cover a site", async () => {
    const { db } = await setup();
    await registerWebFeedSite(db, { siteUrl: "https://cards.example.com/", actorUserId: ADMIN, env: ENV });
    const web = fakeWeb(CARDS_SITE);
    expect(await runWebFeedSyncBatch(db, { budget: 5, clientFor: web.clientFor, env: ENV })).toMatchObject({
      status: "stopped",
      reason: "budget_exhausted",
      sites: 0,
    });
    expect(web.calls).toEqual([]);
  });
});

describe("syncWebFeeds", () => {
  it("does nothing unless PROVIDER_WEB_FEED_MODE is live", async () => {
    const { db } = await setup();
    await registerWebFeedSite(db, { siteUrl: "https://cards.example.com/", actorUserId: ADMIN, env: ENV });
    const web = fakeWeb(CARDS_SITE);
    expect(await syncWebFeeds(db, { env: ENV })).toMatchObject({ status: "skipped", reason: "fixture_not_supported" });
    expect(await syncWebFeeds(db, { env: { ISP_ENV: "staging" } })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(web.calls).toEqual([]);
  });
});
