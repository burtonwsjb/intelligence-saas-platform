import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  evaluateCreatorCallOutcome,
  extractCreatorCallsFromContent,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  readMigrationSql,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import { extractAssetCallsFromContent } from "../creator/assets.js";
import { syncSealedProducts } from "../tcg/sealed.js";
import { collectTccQuotes, TCC_QUOTES_PATH } from "./tcc-quotes.js";
import type { HttpTransport } from "./transport.js";

async function setup(options: { salesAfterPost?: boolean; market?: boolean } = {}) {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  for (const record of options.market === false ? [] : tcgMarketFixtureRecords()) {
    // The fixture call is posted 2026-01-02T12:00Z.
    if (options.salesAfterPost === false && record.price_type === "sold" && record.observed_at > "2026-01-02T12:00:00.000Z") continue;
    await ingestTcgMarketRecord(db, record);
  }
  const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
  const [buyCall] = await extractCreatorCallsFromContent(db, buy.contentId!);
  return { client, db, callId: buyCall!.call!.id };
}

function reference(id: string, price: number, at: string) {
  return {
    provider: "tcg_card_central",
    provider_record_id: id,
    event_type: "tcg.market.reference_price",
    market_type: "market_price",
    price_type: "reference",
    observed_at: at,
    currency: "USD",
    condition: "unknown",
    raw_condition: "product_level",
    price,
    printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
  };
}

describe("TCG Card Central price feed", () => {
  it("prices the cards and sealed products creators called, once a day, in bounded batches", async () => {
    const { client, db } = await setup();
    await syncSealedProducts(db);
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at)
        VALUES ('sa_box', 'youtube', 'UCbox', 'Box Breaker', now(), now());
      INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
        VALUES ('c_box', 'youtube', 'c_box', 'sa_box', '2026-01-03T06:00:00Z',
          'Twilight Masquerade booster box will go up, buy now. 30 days.', 'https://example.test/c_box', 'video', 'c_box');
    `);
    expect(await extractAssetCallsFromContent(db, "c_box")).toHaveLength(1);

    const now = new Date("2026-02-01T09:00:00Z");
    const sent: { url: string; headers?: Record<string, string>; body: { items: Record<string, string>[] } }[] = [];
    const ok = (price: number, productId: number) => ({
      status: "ok",
      currency: "USD",
      price,
      low_price: price - 5,
      mid_price: price,
      high_price: price + 10,
      sub_type: "Normal",
      product_id: productId,
      product_name: `product ${productId}`,
      group_name: "SV06: Twilight Masquerade",
      observed_at: "2026-02-01T08:00:00.000Z",
      price_date: "2026-02-01",
    });
    const transport: HttpTransport = {
      async fetch(url, init) {
        sent.push({ url, headers: init?.headers, body: JSON.parse(init!.body!) });
        return { status: 200, headers: {}, bodyText: JSON.stringify({ ok: true, quotes: [ok(48, 11), ok(152, 12)] }) };
      },
    };
    const report = await collectTccQuotes(db, { baseUrl: "https://tcc.example.test/", token: "fixture-token", transport, now });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://tcc.example.test${TCC_QUOTES_PATH}`);
    expect(sent[0]!.headers?.authorization).toBe("Bearer fixture-token");
    expect(sent[0]!.body.items).toEqual([
      expect.objectContaining({
        kind: "card",
        game: "pokemon",
        set_name: "Twilight Masquerade",
        card_number: "214/167",
        language: "en",
        variant: "normal",
      }),
      { kind: "sealed", game: "pokemon", set_name: "Twilight Masquerade", product_type: "booster_box" },
    ]);
    expect(report).toMatchObject({ requested: 2, requests: 1, cards: 1, sealed: 1, notFound: 0 });
    expect(report.records[0]).toMatchObject({ price: 48, price_type: "reference", condition: "unknown", source_reference: "tcgplayer:11" });
    const { rows: sealedRows } = await client.query<{ price: string }>(
      `SELECT price FROM market_asset_price WHERE source_key = 'tcg_card_central'`,
    );
    expect(sealedRows.map((row) => Number(row.price))).toEqual([152]);

    // Once today's card price is stored, the same day asks nothing again.
    for (const record of report.records) await ingestTcgMarketRecord(db, record);
    const again = await collectTccQuotes(db, { baseUrl: "https://tcc.example.test", token: "fixture-token", transport, now });
    expect(again).toMatchObject({ requested: 0, requests: 0 });
    expect(sent).toHaveLength(1);
  });

  it("drops quotes that are missing or not in dollars", async () => {
    const { db } = await setup();
    const transport: HttpTransport = {
      async fetch() {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ quotes: [{ status: "ok", currency: "EUR", price: 40, price_date: "2026-02-01" }] }),
        };
      },
    };
    const report = await collectTccQuotes(db, {
      baseUrl: "https://tcc.example.test",
      token: "fixture-token",
      transport,
      now: new Date("2026-02-01T09:00:00Z"),
    });
    expect(report).toMatchObject({ requested: 1, cards: 0, notFound: 1, records: [] });
  });
});

describe("judging card calls on the daily market price", () => {
  it("uses market prices when no sales happened, but only with a close near the deadline", async () => {
    // No sales of this card after the post; the 2026-01-04 market price ($43) is too early to close on.
    const { db, callId } = await setup({ salesAfterPost: false });
    const asOf = new Date("2026-03-01T00:00:00Z");
    const early = await evaluateCreatorCallOutcome(db, callId, asOf);
    expect(early).toMatchObject({ evaluationStatus: "insufficient_data", dataQuality: "missing_market_data" });

    await ingestTcgMarketRecord(db, reference("tcc_ref_0130", 55, "2026-01-30T00:00:00.000Z"));
    await ingestTcgMarketRecord(db, reference("tcc_ref_0220", 10, "2026-02-20T00:00:00.000Z")); // after the deadline
    const out = await evaluateCreatorCallOutcome(db, callId, asOf);
    expect(out).toMatchObject({ evaluationStatus: "evaluated", directionalCorrect: "correct", dataQuality: "complete+market_price" });
    expect(Number(out?.endingPrice)).toBe(55);
  });

  it("starts from the first price soon after the post when none was seen before it", async () => {
    // No prices at all before the post, so the call has no price at the time it was made.
    const { db, callId } = await setup({ market: false });
    await ingestTcgMarketRecord(db, reference("tcc_ref_0104", 43, "2026-01-04T00:00:00.000Z"));
    await ingestTcgMarketRecord(db, reference("tcc_ref_0130", 40, "2026-01-30T00:00:00.000Z"));
    const out = await evaluateCreatorCallOutcome(db, callId, new Date("2026-03-01T00:00:00Z"));
    // The 2026-01-04 market price of $43 came within two days of the post.
    expect(Number(out?.startingPrice)).toBe(43);
    expect(Number(out?.endingPrice)).toBe(40);
    expect(out).toMatchObject({ directionalCorrect: "incorrect", dataQuality: "complete+market_price+start_after_call" });
  });
});
