import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationSql, type Database } from "../index.js";
import { importTccCatalog } from "../providers/tcc-catalog.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";
import { WebFeedClient } from "../providers/web-feed.js";
import { user } from "../schema/auth.js";
import { marketScopeTalk } from "../schema/scope-talk.js";
import { tcgPrinting } from "../schema/tcg.js";
import { getCardSentimentWithHistory, getCardTalk } from "../dashboard/explorer.js";
import { getTopicSentiment } from "../topics/topics.js";
import { syncSealedProducts } from "../tcg/sealed.js";
import { resetScopeTalkCaches } from "./scope-talk-store.js";
import { registerWebFeedSite, runWebFeedSyncBatch } from "./web-feed-ingest.js";

const ENV = { NODE_ENV: "test" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PFL = { id: uuid(9001), set_code: "me02", name: "Phantasmal Flames", release_date: "2025-11-14" };
const SSP = { id: uuid(9002), set_code: "sv08", name: "Surging Sparks", release_date: "2024-11-08" };
const card = (n: number, name: string, number: string, rarity: string, set: typeof PFL) => ({
  id: uuid(n),
  name,
  card_number: number,
  rarity,
  variant: "holofoil",
  languages: ["en", "ja"],
  set,
});
const CATALOG = [
  card(1, "Mega Charizard X ex", "013/094", "Double Rare", PFL),
  card(2, "Mega Charizard X ex", "125/094", "Special Illustration Rare", PFL),
  card(3, "Pikachu ex", "238/191", "Special Illustration Rare", SSP),
  card(4, "Latias ex", "076/191", "Double Rare", SSP),
];

function rss(site: string, items: Array<{ slug: string; title: string; body: string; date: string }>) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${site}</title>
${items
  .map(
    (item) => `<item><title>${item.title}</title><link>https://${site}/${item.slug}/</link>
<pubDate>${item.date}</pubDate><content:encoded><![CDATA[<p>${item.body}</p>]]></content:encoded></item>`,
  )
  .join("\n")}</channel></rss>`;
}

const NOW = new Date("2026-11-12T00:00:00Z");

async function setup() {
  resetScopeTalkCaches();
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await db.insert(user).values({ id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true });
  const catalogFeed: HttpTransport = {
    async fetch(url) {
      const game = new URL(url).searchParams.get("game");
      const cards = game === "pokemon" ? CATALOG : [];
      return { status: 200, headers: {}, bodyText: JSON.stringify({ ok: true, game, cards, next_after: null }) };
    },
  };
  await importTccCatalog(db, { baseUrl: "https://tcc.example.test/", token: "t", transport: catalogFeed, now: new Date("2026-10-01T00:00:00Z") });
  await syncSealedProducts(db);
  const routes: Record<string, HttpResponse> = {};
  const sites = {
    "flames.example.com": rss("flames.example.com", [
      {
        slug: "pfl-update",
        title: "Market update",
        body: "The sealed of Phantasmal Flames is going down, but the singles are going up, especially the Mega Charizard X ex.",
        date: "Mon, 09 Nov 2026 12:00:00 +0000",
      },
    ]),
    "sparks.example.com": rss("sparks.example.com", [
      {
        slug: "ssp-update",
        title: "Surging Sparks check in",
        body: "All of Surging Sparks is going down except this Pikachu ex. Wait until January to buy.",
        date: "Tue, 10 Nov 2026 12:00:00 +0000",
      },
    ]),
  };
  for (const [domain, feed] of Object.entries(sites)) {
    await registerWebFeedSite(db, { siteUrl: `https://${domain}/`, actorUserId: "user_admin", env: ENV });
    routes[`https://${domain}/robots.txt`] = { status: 200, headers: { "content-type": "text/plain" }, bodyText: "User-agent: *\nAllow: /\n" };
    routes[`https://${domain}/`] = { status: 200, headers: { "content-type": "text/html" }, bodyText: "<html></html>" };
    routes[`https://${domain}/feed`] = { status: 200, headers: { "content-type": "application/rss+xml" }, bodyText: feed };
  }
  const transport: HttpTransport = { async fetch(url) { return routes[url] ?? { status: 404, headers: {}, bodyText: "" }; } };
  const clientFor = () => new WebFeedClient({ transport, lookup: async () => ["93.184.216.34"], env: {} });
  await runWebFeedSyncBatch(db, { budget: 50, clientFor, env: ENV, now: NOW });
  const printings = await db.select().from(tcgPrinting);
  const printing = (number: string, language = "en") =>
    printings.find((row) => row.collectorNumber === number && row.languageCode === language)!.id;
  return { db, printing };
}

describe("set, sealed and group talk in card sentiment", () => {
  it("stores each clause and counts the most specific one per card", async () => {
    const { db, printing } = await setup();
    const talk = await db.select().from(marketScopeTalk);
    const brief = talk.map((row) => `${row.scope}:${row.productType ?? row.cardName ?? ""}:${row.sentiment}:${row.horizonDays ?? "-"}`).sort();
    expect(brief).toEqual(
      [
        "sealed::negative:-",
        "singles::positive:-",
        "card:mega charizard x ex:positive:-",
        "set::negative:52",
        "card:pikachu ex:excluded:52",
      ].sort(),
    );

    // Charizard: named with "especially" after "singles are going up".
    const charizard = await getCardSentimentWithHistory(db, printing("125/094"), "30d", { now: NOW });
    expect(charizard.summary.counts.positive).toBe(1);
    expect(charizard.summary.byScope.card).toBe(1);

    // Latias: covered only by "all of Surging Sparks is going down".
    const latias = await getCardSentimentWithHistory(db, printing("076/191"), "30d", { now: NOW });
    expect(latias.summary.counts.negative).toBe(1);
    expect(latias.summary.byScope.set).toBe(1);

    // Pikachu: taken out of the set call with "except", no direction of its own.
    const pikachu = await getCardSentimentWithHistory(db, printing("238/191"), "30d", { now: NOW });
    expect(pikachu.summary.classified).toBe(0);

    // The Japanese printing is not covered by an English post about the set.
    const latiasJa = await getCardSentimentWithHistory(db, printing("076/191", "ja"), "30d", { now: NOW });
    expect(latiasJa.summary.classified).toBe(0);

    // "Wait until January" keeps the set call alive past the 30-day window.
    const later = await getCardSentimentWithHistory(db, printing("076/191"), "7d", { now: new Date("2026-12-28T00:00:00Z") });
    expect(later.summary.counts.negative).toBe(1);
    const afterJanuary = await getCardSentimentWithHistory(db, printing("076/191"), "30d", { now: new Date("2027-01-05T00:00:00Z") });
    expect(afterJanuary.summary.classified).toBe(0);

    const quotes = await getCardTalk(db, printing("076/191"), "30d", { now: NOW });
    expect(quotes.quotes.map((quote) => [quote.scope, quote.sentiment, quote.horizonPhrase])).toEqual([["set", "negative", "wait until january"]]);
  });

  it("counts sealed talk for the set's sealed products, not its singles", async () => {
    const { db, printing } = await setup();
    const box = await getTopicSentiment(db, "Phantasmal Flames Booster Box", "30d", { now: NOW });
    expect(box.summary.counts.negative).toBe(1);
    expect(box.summary.counts.positive).toBe(0);
    // "especially the Mega Charizard X ex" covers every printing of that card in the set.
    const dr = await getCardSentimentWithHistory(db, printing("013/094"), "30d", { now: NOW });
    expect(dr.summary.counts.positive).toBe(1);
    expect(dr.summary.byScope.card).toBe(1);
  });
});
