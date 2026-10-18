import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpResponse, HttpTransport } from "./transport.js";
import {
  WEB_FEED_BOT_TOKEN,
  WebFeedClient,
  articleText,
  createWebFeedTransport,
  discoverFeedLinks,
  htmlToText,
  parseFeed,
  parseRobotsTxt,
  parseXml,
  readWebFeed,
  robotsAllows,
  textParagraphs,
  webFeedUserAgent,
} from "./web-feed.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/web-feed/${name}`, import.meta.url), "utf8");
const RSS = fixture("rss.xml");
const ATOM = fixture("atom.xml");
const HOMEPAGE = fixture("homepage.html");
const ROBOTS = fixture("robots.txt");

const publicLookup = async () => ["93.184.216.34"];

type Route = HttpResponse | ((headers: Record<string, string>) => HttpResponse);

function fakeSite(routes: Record<string, Route>) {
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
  return { transport, calls, client: (maxRequests?: number) => new WebFeedClient({ transport, lookup: publicLookup, maxRequests, env: {} }) };
}

const ok = (bodyText: string, contentType = "application/rss+xml; charset=UTF-8", extra: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  headers: { "content-type": contentType, ...extra },
  bodyText,
});

describe("parseFeed", () => {
  it("reads RSS 2.0 items with content:encoded, CDATA, entities and guid", () => {
    const feed = parseFeed(RSS, "https://cards.example.com/feed/");
    expect(feed?.format).toBe("rss");
    expect(feed?.title).toBe("Card Insider & Friends");
    expect(feed?.items).toHaveLength(2);
    const [first, second] = feed!.items;
    expect(first).toMatchObject({
      id: "https://cards.example.com/?p=101",
      link: "https://cards.example.com/2026/09/three-cards/?utm_source=rss&utm_medium=rss",
      title: "Three cards I’m buying this month",
      author: "Sam Collector",
    });
    expect(first!.publishedAt?.toISOString()).toBe("2026-09-01T14:00:00.000Z");
    // content:encoded wins over the teaser description.
    expect(first!.html).toContain("I would buy <strong>Charizard ex 006</strong>");
    expect(first!.html).not.toContain("teaser");
    // Entity-escaped HTML in a plain description is kept as HTML.
    expect(second!.html).toContain("<b>and</b>");
    // Declared entities are never expanded.
    expect(JSON.stringify(feed)).not.toContain("should never expand");
  });

  it("reads Atom entries with xhtml and html bodies and the alternate link", () => {
    const feed = parseFeed(ATOM, "https://atom.example.org/atom.xml");
    expect(feed?.format).toBe("atom");
    expect(feed?.items).toHaveLength(2);
    const [first, second] = feed!.items;
    expect(first).toMatchObject({
      id: "tag:atom.example.org,2026:2",
      link: "https://atom.example.org/posts/selling-pikachu",
      title: "Why I'm selling Pikachu",
      author: "Alex Atom",
    });
    expect(first!.publishedAt?.toISOString()).toBe("2026-09-02T12:00:00.000Z");
    expect(textParagraphs(htmlToText(first!.html!))).toEqual(["Prices are wild.", "I think Charizard ex is overpriced, sell now."]);
    expect(second!.link).toBe("https://atom.example.org/posts/summary-only");
    expect(htmlToText(second!.html!)).toBe("Keep an eye on Greninja ex.");
  });

  it("returns null for documents that are not feeds", () => {
    expect(parseFeed(HOMEPAGE)).toBeNull();
    expect(parseFeed("not xml at all")).toBeNull();
    expect(parseXml("<a><b>unclosed")?.name).toBe("a");
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps paragraphs and decodes entities", () => {
    const text = htmlToText(
      `<style>p{}</style><p>One &amp; two&nbsp;three</p><script>alert(1)</script><div>Next<br>line</div><!-- hidden -->`,
    );
    expect(text).toBe("One & two three\n\nNext\nline");
    expect(textParagraphs(text)).toEqual(["One & two three", "Next line"]);
  });

  it("prefers the article element of a page", () => {
    expect(articleText("<body><nav>Menu</nav><article><p>Body text</p></article><footer>F</footer></body>")).toBe("Body text");
  });
});

describe("discoverFeedLinks", () => {
  it("finds rss/atom alternate links and skips comment feeds and other types", () => {
    expect(discoverFeedLinks(HOMEPAGE, "https://cards.example.com/")).toEqual(["https://cards.example.com/feed/"]);
  });
});

describe("robots.txt", () => {
  const groups = parseRobotsTxt(ROBOTS);

  it("uses the SentimentBot group over *", () => {
    expect(robotsAllows(groups, WEB_FEED_BOT_TOKEN, "/private/post")).toBe(false);
    expect(robotsAllows(groups, WEB_FEED_BOT_TOKEN, "/private/ok")).toBe(true);
    expect(robotsAllows(groups, WEB_FEED_BOT_TOKEN, "/private/ok/more")).toBe(false);
    // The specific group replaces *, so /wp-admin/ is allowed for SentimentBot.
    expect(robotsAllows(groups, WEB_FEED_BOT_TOKEN, "/wp-admin/")).toBe(true);
    expect(robotsAllows(groups, WEB_FEED_BOT_TOKEN, "/feed/")).toBe(true);
  });

  it("falls back to * with longest match and Allow winning ties", () => {
    expect(robotsAllows(groups, "OtherBot", "/wp-admin/edit.php")).toBe(false);
    expect(robotsAllows(groups, "OtherBot", "/wp-admin/admin-ajax.php")).toBe(true);
    expect(robotsAllows(groups, "BadBot", "/feed/")).toBe(false);
    expect(robotsAllows(parseRobotsTxt("User-agent: *\nDisallow: /*.xml$\n"), WEB_FEED_BOT_TOKEN, "/feed.xml")).toBe(false);
    expect(robotsAllows(parseRobotsTxt("User-agent: *\nDisallow:\n"), WEB_FEED_BOT_TOKEN, "/anything")).toBe(true);
    expect(robotsAllows([], WEB_FEED_BOT_TOKEN, "/")).toBe(true);
  });
});

describe("readWebFeed", () => {
  it("discovers the feed from the homepage link and identifies itself", async () => {
    const site = fakeSite({
      "https://cards.example.com/robots.txt": ok(ROBOTS, "text/plain"),
      "https://cards.example.com/": ok(HOMEPAGE, "text/html"),
      "https://cards.example.com/feed/": ok(RSS, "application/rss+xml", { etag: '"v1"', "last-modified": "Tue, 01 Sep 2026 14:00:00 GMT" }),
    });
    const client = site.client();
    const result = await readWebFeed(client, { siteUrl: "https://cards.example.com/", feedUrl: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.feedUrl).toBe("https://cards.example.com/feed/");
    expect(result.etag).toBe('"v1"');
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0]!.text).toContain("I would buy Charizard ex 006 from Scarlet & Violet right now.");
    expect(result.posts[0]!.text).not.toContain("alert");
    expect(site.calls.map((call) => call.url)).toEqual([
      "https://cards.example.com/robots.txt",
      "https://cards.example.com/",
      "https://cards.example.com/feed/",
    ]);
    expect(client.requests).toBe(3);
    expect(site.calls[2]!.headers["user-agent"]).toMatch(/^SentimentBot\/1\.0/);
  });

  it("tries the common feed paths when the homepage advertises none", async () => {
    const site = fakeSite({
      "https://atom.example.org/": ok("<html><head></head><body>hi</body></html>", "text/html"),
      "https://atom.example.org/atom.xml": ok(ATOM, "application/atom+xml"),
    });
    const result = await readWebFeed(site.client(), { siteUrl: "https://atom.example.org/", feedUrl: null });
    expect(result).toMatchObject({ status: "ok", format: "atom", feedUrl: "https://atom.example.org/atom.xml" });
    expect(site.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/robots.txt",
      "/",
      "/feed",
      "/rss.xml",
      "/feed.xml",
      "/atom.xml",
    ]);
  });

  it("never requests a feed robots.txt disallows", async () => {
    const site = fakeSite({
      "https://blocked.example.com/robots.txt": ok("User-agent: SentimentBot\nDisallow: /\n", "text/plain"),
      "https://blocked.example.com/feed/": ok(RSS),
    });
    const result = await readWebFeed(site.client(), {
      siteUrl: "https://blocked.example.com/",
      feedUrl: "https://blocked.example.com/feed/",
    });
    expect(result).toMatchObject({ status: "skipped", reason: "robots" });
    expect(site.calls.map((call) => call.url)).toEqual(["https://blocked.example.com/robots.txt"]);
  });

  it("treats an unreachable robots.txt as disallowed", async () => {
    const site = fakeSite({
      "https://down.example.com/robots.txt": { status: 503, headers: {}, bodyText: "" },
    });
    const result = await readWebFeed(site.client(), { siteUrl: "https://down.example.com/", feedUrl: "https://down.example.com/feed" });
    expect(result.status).toBe("skipped");
    expect(site.calls).toHaveLength(1);
  });

  it("sends validators and reports not modified", async () => {
    const site = fakeSite({
      "https://cards.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
      "https://cards.example.com/feed/": (headers) =>
        headers["if-none-match"] === '"v1"' ? { status: 304, headers: {}, bodyText: "" } : ok(RSS),
    });
    const result = await readWebFeed(site.client(), {
      siteUrl: "https://cards.example.com/",
      feedUrl: "https://cards.example.com/feed/",
      etag: '"v1"',
      lastModified: "Tue, 01 Sep 2026 14:00:00 GMT",
    });
    expect(result).toMatchObject({ status: "not_modified", etag: '"v1"' });
    expect(site.calls[1]!.headers["if-modified-since"]).toBe("Tue, 01 Sep 2026 14:00:00 GMT");
  });

  it("reads the article page only for title-only items, bounded", async () => {
    const titleOnly = `<rss version="2.0"><channel><title>T</title>
      <item><title>Post</title><link>https://titles.example.com/post-1</link><pubDate>Tue, 01 Sep 2026 14:00:00 GMT</pubDate></item>
      </channel></rss>`;
    const site = fakeSite({
      "https://titles.example.com/robots.txt": ok("User-agent: *\nDisallow: /private/\n", "text/plain"),
      "https://titles.example.com/feed": ok(titleOnly),
      "https://titles.example.com/post-1": ok(
        "<html><body><nav>menu</nav><article><p>I would buy Charizard ex.</p></article></body></html>",
        "text/html",
      ),
    });
    const result = await readWebFeed(site.client(), { siteUrl: "https://titles.example.com/", feedUrl: "https://titles.example.com/feed" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.posts[0]).toMatchObject({ textSource: "article", text: "I would buy Charizard ex." });
  });

  it("follows a public redirect but refuses one to a private address", async () => {
    const site = fakeSite({
      "https://moved.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
      "https://moved.example.com/feed": { status: 301, headers: { location: "https://new.example.com/feed" }, bodyText: "" },
      "https://new.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
      "https://new.example.com/feed": ok(RSS),
      "https://evil.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
      "https://evil.example.com/feed": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, bodyText: "" },
    });
    const moved = await readWebFeed(site.client(), { siteUrl: "https://moved.example.com/", feedUrl: "https://moved.example.com/feed" });
    expect(moved).toMatchObject({ status: "ok", feedUrl: "https://new.example.com/feed" });
    const before = site.calls.length;
    const evil = await readWebFeed(site.client(2), { siteUrl: "https://evil.example.com/", feedUrl: "https://evil.example.com/feed" });
    expect(evil.status).not.toBe("ok");
    expect(site.calls.slice(before).some((call) => call.url.includes("169.254"))).toBe(false);
  });

  it("refuses local addresses and hosts that resolve to private addresses", async () => {
    const site = fakeSite({});
    expect(await readWebFeed(site.client(), { siteUrl: "http://localhost:3000/", feedUrl: null })).toMatchObject({
      status: "skipped",
      reason: "url_rejected",
    });
    const rebinding = new WebFeedClient({ transport: site.transport, lookup: async () => ["10.0.0.5"], env: {} });
    expect(await readWebFeed(rebinding, { siteUrl: "https://internal.example.com/", feedUrl: null })).toMatchObject({
      status: "skipped",
      reason: "url_rejected",
    });
    expect(site.calls).toEqual([]);
  });

  it("stops at the per-site request cap", async () => {
    const site = fakeSite({
      "https://nofeed.example.com/robots.txt": { status: 404, headers: {}, bodyText: "" },
      "https://nofeed.example.com/": ok("<html></html>", "text/html"),
    });
    const client = site.client(4);
    const result = await readWebFeed(client, { siteUrl: "https://nofeed.example.com/", feedUrl: null });
    expect(result).toMatchObject({ status: "failed", reason: "request_cap" });
    expect(client.requests).toBe(4);
    expect(site.calls).toHaveLength(4);
  });
});

describe("createWebFeedTransport", () => {
  it("does not follow redirects and cuts long bodies", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response("x".repeat(5_000), { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const response = await createWebFeedTransport({ maxBytes: 1_000, fetchImpl }).fetch("https://example.com/feed");
    expect(seen?.redirect).toBe("manual");
    expect(response.bodyText).toHaveLength(1_000);
    expect(response.headers["x-sentiment-truncated"]).toBe("1");
  });

  it("names the bot and the app in the user agent", () => {
    expect(webFeedUserAgent({ APP_URL: "https://app.example.com/path" })).toMatch(/^SentimentBot\/1\.0 \(\+https:\/\/app\.example\.com\)/);
  });
});
