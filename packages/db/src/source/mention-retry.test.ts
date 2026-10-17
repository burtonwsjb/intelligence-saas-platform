import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, isNotNull } from "drizzle-orm";
import { persistResolution } from "../resolution/persist.js";
import { readMigrationSql, type Database } from "../index.js";
import { importTccCatalog } from "../providers/tcc-catalog.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";
import { WebFeedClient } from "../providers/web-feed.js";
import { user } from "../schema/auth.js";
import { creatorCall } from "../schema/creator.js";
import { providerSyncRun } from "../schema/provider.js";
import { entityResolutionAttempt } from "../schema/resolution.js";
import { sourceMention } from "../schema/source.js";
import { tcgPrinting } from "../schema/tcg.js";
import { MENTION_RETRY_KEY, MENTION_RETRY_TRIGGER, retryUnboundDetectedMentions } from "./mention-retry.js";
import { traceSourcePost } from "./post-trace.js";
import { listCardEvidence, listSentimentEvidence, summarizeSentiment } from "../dashboard/explorer.js";
import { sourceSentiment } from "../schema/provider.js";
import { registerWebFeedSite, runWebFeedSyncBatch } from "./web-feed-ingest.js";

const ENV = { NODE_ENV: "test" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME02 = { id: uuid(9001), set_code: "me02", name: "Phantasmal Flames", release_date: "2025-11-14" };
const card = (n: number, number: string, rarity: string) => ({
  id: uuid(n),
  name: "Mega Charizard X ex",
  card_number: number,
  rarity,
  variant: "holofoil",
  // TCC lists English and Japanese for this card, so each number has two printings.
  languages: ["en", "ja"],
  set: ME02,
});
const CATALOG = [card(1, "013/094", "Double Rare"), card(2, "125/094", "Special Illustration Rare"), card(3, "130/094", "Mega Hyper Rare")];

const ARTICLE = `<p>TL;DR: WAIT on the Mega Charizard X ex 125/094 SIR. It sits at $660.86, not $221. I would buy at $600.</p>
${"<p>Volume is thin and the weekly closes keep grinding lower, so I am waiting for my levels before I add another copy.</p>".repeat(8)}
<p>The Japanese Mega Charizard X ex 130/094 is the one I am selling.</p>`;
const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Insider</title>
<item><title>Mega Charizard X ex SIR price</title><link>https://insider.example.com/2026/10/07/mega-charizard-x-ex-price/</link>
<pubDate>Thu, 08 Oct 2026 00:41:21 +0000</pubDate><content:encoded><![CDATA[${ARTICLE}]]></content:encoded></item></channel></rss>`;

async function setup() {
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
  const printings = await db.select().from(tcgPrinting);
  const printing = (number: string, language: string) =>
    printings.find((row) => row.collectorNumber === number && row.languageCode === language)!.id;
  await registerWebFeedSite(db, { siteUrl: "https://insider.example.com/", actorUserId: "user_admin", env: ENV });
  const routes: Record<string, HttpResponse> = {
    "https://insider.example.com/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, bodyText: "User-agent: *\nAllow: /\n" },
    "https://insider.example.com/": { status: 200, headers: { "content-type": "text/html" }, bodyText: "<html></html>" },
    "https://insider.example.com/feed": { status: 200, headers: { "content-type": "application/rss+xml" }, bodyText: RSS },
  };
  const transport: HttpTransport = { async fetch(url) { return routes[url] ?? { status: 404, headers: {}, bodyText: "" }; } };
  const clientFor = () => new WebFeedClient({ transport, lookup: async () => ["93.184.216.34"], env: {} });
  await runWebFeedSyncBatch(db, { budget: 50, clientFor, env: ENV });
  return { db, printing };
}

async function latestAttempt(db: Database, mentionId: string) {
  const rows = await db.select().from(entityResolutionAttempt).where(eq(entityResolutionAttempt.mentionId, mentionId));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0]!;
}

describe("website mentions of a card printed in several languages", () => {
  it("bind to the post's language unless the text names another", async () => {
    const { db, printing } = await setup();
    const mentions = await db.select().from(sourceMention);
    const sir = mentions.find((row) => row.rawEntityText === "Mega Charizard X ex 125/094")!;
    const gold = mentions.find((row) => row.rawEntityText === "Mega Charizard X ex 130/094")!;
    expect(await latestAttempt(db, sir.id)).toMatchObject({ status: "exact", chosenPrintingId: printing("125/094", "en") });
    expect(await latestAttempt(db, gold.id)).toMatchObject({ status: "exact", chosenPrintingId: printing("130/094", "ja") });
    const calls = await db.select().from(creatorCall).where(eq(creatorCall.mentionId, sir.id));
    expect(calls).toMatchObject([{ printingId: printing("125/094", "en") }]);
  });

  it("retries mentions an earlier resolver left unbound, once", async () => {
    const { db, printing } = await setup();
    const sir = (await db.select().from(sourceMention)).find((row) => row.rawEntityText === "Mega Charizard X ex 125/094")!;
    // What the resolver stored before it read posts in their own language.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await persistResolution(db, {
      subjectType: "mention",
      subjectId: sir.id,
      mentionId: sir.id,
      status: "ambiguous",
      targetLayer: "concept",
      chosenPrintingId: null,
      chosenConceptId: null,
      confidence: null,
      signals: {},
      candidates: [],
    });
    expect((await latestAttempt(db, sir.id)).status).toBe("ambiguous");

    const first = await retryUnboundDetectedMentions(db);
    // The SIR binds again; the title mention (no number) stays unbound. Its
    // call already exists from the first read, so nothing is duplicated.
    expect(first).toEqual({ scanned: 3, retried: 2, bound: 1, callsCreated: 0 });
    expect(await db.select().from(creatorCall).where(eq(creatorCall.mentionId, sir.id))).toHaveLength(1);
    expect(await latestAttempt(db, sir.id)).toMatchObject({ status: "exact", chosenPrintingId: printing("125/094", "en") });
    const [run] = await db.select().from(providerSyncRun).where(eq(providerSyncRun.trigger, MENTION_RETRY_TRIGGER));
    expect(run!.checkpoint).toMatchObject({ key: MENTION_RETRY_KEY, bound: 1 });
    // The cursor is past every mention, so the next run reads nothing new.
    expect(await retryUnboundDetectedMentions(db)).toEqual({ scanned: 0, retried: 0, bound: 0, callsCreated: 0 });
  });

  it("traces a stored post, its mentions and the card's printings", async () => {
    const { db } = await setup();
    const trace = await traceSourcePost(db, {
      url: "https://insider.example.com/2026/10/07/mega-charizard-x-ex-price/?utm_source=rss",
      cardName: "Mega Charizard X ex",
    });
    expect(trace).toMatchObject({ domain: "insider.example.com", accounts: [{ handle: "insider.example.com" }] });
    const posts = (trace as { posts: Array<{ mentions: Array<{ raw: string; status: string; chosen_language: string | null }> }> }).posts;
    expect(posts).toHaveLength(1);
    expect(posts[0]!.mentions).toEqual(
      expect.arrayContaining([expect.objectContaining({ raw: "Mega Charizard X ex 125/094", status: "exact", chosen_language: "en" })]),
    );
    expect((trace as { printings: unknown[] }).printings).toHaveLength(6);
    expect((trace as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
    expect(posts[0]!.mentions).toEqual(
      expect.arrayContaining([expect.objectContaining({ raw: "Mega Charizard X ex 125/094", sentiment: expect.any(String) })]),
    );
    expect((trace as { sentiment: unknown[] }).sentiment).toEqual(
      expect.arrayContaining([expect.objectContaining({ collector_number: "125/094", label: "too_few", posts: 1, classified: 1 })]),
    );
  });

  it("counts a matched post's sentiment toward the card", async () => {
    const { db, printing } = await setup();
    const range = { from: new Date("2026-09-20T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
    const sir = printing("125/094", "en");
    const rows = await listSentimentEvidence(db, [sir], range);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.sentiment !== "unknown")).toBe(true);
    const summary = summarizeSentiment(rows, range);
    expect(summary).toMatchObject({ contentItems: 1, classified: 1 });
    expect(summary.label).not.toBe("no_evidence");
    const evidence = await listCardEvidence(db, sir);
    expect(evidence.items).toHaveLength(1);
    expect(evidence.items[0]!.sentiment).not.toBe("unknown");
  });

  it("reads the analysis for mentions stored before their sentiment was copied over", async () => {
    const { db, printing } = await setup();
    const sir = printing("125/094", "en");
    const range = { from: new Date("2026-09-20T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
    const [before] = await listSentimentEvidence(db, [sir], range);
    const [mention] = await db.select().from(sourceMention).where(eq(sourceMention.rawEntityText, "Mega Charizard X ex 125/094"));
    // An older mention row: same post, stored as unknown, with its analysis only in source_sentiment.
    const legacyId = `${mention!.id}_legacy`;
    await db.insert(sourceMention).values({ ...mention!, id: legacyId, normalizedEntityText: "legacy", sentiment: "unknown" });
    await db.insert(sourceSentiment).values({
      id: `sst_${legacyId}`,
      mentionId: legacyId,
      analyzerVersion: "test",
      direction: "bearish",
      strength: "moderate",
      subject: "card",
      entityKind: "printing",
      timeHorizon: "unspecified",
      marketRelevance: "direct",
      excitement: "absent",
      purchaseIntent: "none",
      priceExpectation: "none",
      creatorRecommendation: "none",
      marketConcern: "none",
      evidence: [],
    });
    await persistResolution(db, {
      subjectType: "mention",
      subjectId: legacyId,
      mentionId: legacyId,
      status: "exact",
      targetLayer: "printing",
      chosenPrintingId: sir,
      chosenConceptId: null,
      confidence: 1,
      signals: {},
      candidates: [],
    });
    const rows = await listSentimentEvidence(db, [sir], range);
    expect(rows.find((row) => row.sentiment === "negative")).toBeTruthy();
    expect(rows.find((row) => row.sentiment === before!.sentiment)).toBeTruthy();
  });

  it("falls back to the post's calls when neither the mention nor its own call says anything", async () => {
    const { db, printing } = await setup();
    const mhr = printing("130/094", "en");
    const range = { from: new Date("2026-09-20T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
    const [mention] = await db.select().from(sourceMention).where(eq(sourceMention.rawEntityText, "Mega Charizard X ex 125/094"));
    const calls = await db.select().from(creatorCall).where(eq(creatorCall.contentId, mention!.contentId));
    expect(calls.some((call) => call.direction === "bullish")).toBe(true);
    // A recap mention of another printing in the same post, with no analysis and no call of its own.
    const recapId = `${mention!.id}_recap`;
    await db.insert(sourceMention).values({ ...mention!, id: recapId, normalizedEntityText: "recap", sentiment: "unknown" });
    await persistResolution(db, {
      subjectType: "mention",
      subjectId: recapId,
      mentionId: recapId,
      status: "exact",
      targetLayer: "printing",
      chosenPrintingId: mhr,
      chosenConceptId: null,
      confidence: 1,
      signals: {},
      candidates: [],
    });
    const rows = (await listSentimentEvidence(db, [mhr], range)).filter((row) => row.contentId === mention!.contentId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.sentiment === "positive")).toBe(true);
  });

  it("falls back to the creator call's direction when the mention has no readable sentiment", async () => {
    const { db, printing } = await setup();
    const sir = printing("125/094", "en");
    const range = { from: new Date("2026-09-20T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
    const [call] = await db.select().from(creatorCall).where(isNotNull(creatorCall.mentionId)).limit(1);
    const [mention] = await db.select().from(sourceMention).where(eq(sourceMention.id, call!.mentionId!));
    // Same post and call, but the stored mention and its analysis say nothing.
    const legacyId = `${mention!.id}_nocall`;
    await db.insert(sourceMention).values({ ...mention!, id: legacyId, normalizedEntityText: "no-analysis", sentiment: "unknown" });
    await db.insert(creatorCall).values({ ...call!, id: `${call!.id}_nocall`, mentionId: legacyId, direction: "bearish", fingerprint: `${call!.fingerprint}_nocall` });
    await persistResolution(db, {
      subjectType: "mention",
      subjectId: legacyId,
      mentionId: legacyId,
      status: "exact",
      targetLayer: "printing",
      chosenPrintingId: sir,
      chosenConceptId: null,
      confidence: 1,
      signals: {},
      candidates: [],
    });
    const rows = await listSentimentEvidence(db, [sir], range);
    expect(rows.find((row) => row.sentiment === "negative")).toBeTruthy();
  });
});
