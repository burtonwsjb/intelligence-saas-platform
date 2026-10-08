import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { extractCallDeterministic } from "./extract.js";
import { extractAssetCallsFromContent, findAssetForTopic, listActiveAssets, matchAssets } from "./assets.js";
import { scoreDueCreatorCalls } from "./due.js";
import { getCreatorAuthorityProfile } from "./authority.js";
import { getTopicCalls, getTopicSentiment } from "../topics/topics.js";
import { syncAssetPrices } from "../providers/asset-prices.js";
import type { HttpTransport } from "../providers/transport.js";

const DAY = 86_400_000;

describe("asset names in text", () => {
  const assets = [
    { id: "btc", aliases: ["bitcoin", "btc"] },
    { id: "eth", aliases: ["ethereum", "eth", "ether"] },
  ];
  it("matches whole words only", () => {
    expect(matchAssets("BTC to the moon", assets).map((row) => row.id)).toEqual(["btc"]);
    expect(matchAssets("Is ETH. undervalued?", assets).map((row) => row.id)).toEqual(["eth"]);
    expect(matchAssets("this method works together", assets)).toEqual([]);
    expect(matchAssets("Bitcoin vs Ethereum", assets).map((row) => row.id)).toEqual(["btc", "eth"]);
  });

  it("reads thousands and millions in price targets", () => {
    expect(extractCallDeterministic({ text: "Bitcoin to $100k, buy" })?.target_price).toBe(100_000);
    expect(extractCallDeterministic({ text: "buy, target $1,250" })?.target_price).toBe(1_250);
    expect(extractCallDeterministic({ text: "buy at $42 within 30 days" })?.target_price).toBe(42);
  });
});

describe("calls about non-card assets", () => {
  let client: PGlite;
  let db: Database;

  async function price(asset: string, at: string, value: number) {
    await client.query(
      `INSERT INTO market_asset_price (id, asset_id, source_key, observed_at, price, currency)
       VALUES ($1, $2, 'fixture', $3, $4, 'USD')`,
      [`p_${asset}_${at}`, asset, at, value],
    );
  }

  async function post(id: string, account: string, at: string, title: string) {
    await client.query(
      `INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
       VALUES ($1, 'youtube', $1, $2, $3, $4, 'https://example.test/' || $1, 'video', $1)`,
      [id, account, at, title],
    );
  }

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at) VALUES
        ('sa_good', 'youtube', 'UCgood', 'Good Caller', now(), now()),
        ('sa_late', 'youtube', 'UClate', 'Late Caller', now(), now());
    `);
    await price("mas_crypto_btc", "2025-12-31T00:00:00Z", 40_000);
    await price("mas_crypto_btc", "2026-01-15T00:00:00Z", 45_000);
    await price("mas_crypto_btc", "2026-01-30T00:00:00Z", 48_000);
    await price("mas_crypto_btc", "2026-03-01T00:00:00Z", 30_000); // after the horizon, must be ignored
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("ships with Bitcoin, Ethereum and Solana and maps topics onto them", async () => {
    expect((await listActiveAssets(db)).map((row) => row.assetKey)).toEqual(["crypto:btc", "crypto:eth", "crypto:sol"]);
    expect((await findAssetForTopic(db, "  BTC "))?.assetKey).toBe("crypto:btc");
    expect((await findAssetForTopic(db, "Bitcoin price"))).toBeNull();
  });

  it("extracts a call, scores it without look-ahead and builds an asset slice", async () => {
    await post("c_good", "sa_good", "2026-01-01T00:00:00Z", "Bitcoin will go up, buy now. 30 days.");
    const [result] = await extractAssetCallsFromContent(db, "c_good");
    expect(result).toMatchObject({ status: "processed", assetId: "mas_crypto_btc" });
    const call = (result as { call: { priceAtCall: string | null; printingId: string | null } }).call;
    expect(Number(call.priceAtCall)).toBe(40_000);
    expect(call.printingId).toBeNull();
    // Running extraction again finds the same call.
    expect((await extractAssetCallsFromContent(db, "c_good"))[0]?.status).toBe("duplicate");

    const report = await scoreDueCreatorCalls(db, { asOf: new Date("2026-02-15T00:00:00Z") });
    expect(report).toMatchObject({ evaluated: 1, creatorsRecomputed: 1 });
    const calls = await getTopicCalls(db, "mas_crypto_btc");
    expect(calls).toMatchObject({ total: 1, evaluated: 1, correct: 1, pending: 0 });
    expect(calls.calls[0]?.returnPct).toBeCloseTo(0.2);
    expect(calls.latestPrice?.price).toBe("30000.0000000000");

    const profile = await getCreatorAuthorityProfile(db, calls.calls[0]!.creatorId);
    const assetSlice = profile.slices.find((row) => row.gameKey === "asset" && row.setKey === "crypto:btc");
    expect(Number(assetSlice?.sampleSize)).toBe(1);
    expect(profile.headline?.gameKey).toBeNull();
  });

  it("waits for a closing price, then gives up after the grace period", async () => {
    await post("c_late", "sa_late", "2026-04-01T00:00:00Z", "BTC is going down, sell. 7 days.");
    const [result] = await extractAssetCallsFromContent(db, "c_late");
    expect(result?.status).toBe("processed");
    const waiting = await scoreDueCreatorCalls(db, { asOf: new Date("2026-04-10T00:00:00Z") });
    expect(waiting).toMatchObject({ considered: 1, pending: 1 });
    const done = await scoreDueCreatorCalls(db, { asOf: new Date("2026-04-20T00:00:00Z") });
    expect(done).toMatchObject({ considered: 1, insufficient: 1 });
  });

  it("weights an asset topic by the creator's record on that asset and matches any of its names", async () => {
    await post("c_noise", "sa_late", "2026-01-20T00:00:00Z", "A better method for sorting binders");
    const result = await getTopicSentiment(db, "Bitcoin", "90d", { now: new Date("2026-02-01T00:00:00Z") });
    expect(result.asset?.assetKey).toBe("crypto:btc");
    expect(result.summary.contentItems).toBe(1);
    expect(result.voices[0]).toMatchObject({ name: "Good Caller", rated: true });
  });
});

describe("asset price feed", () => {
  let client: PGlite;
  let db: Database;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  function fakeTransport(urls: string[]): HttpTransport {
    const now = Date.parse("2026-10-01T00:00:00Z");
    return {
      async fetch(url) {
        urls.push(url);
        if (url.includes("/market_chart")) {
          const body = { prices: [[now - 2 * DAY, 100], [now - DAY, 110], [now, 120]] };
          return { status: 200, headers: {}, bodyText: JSON.stringify(body) };
        }
        const body = {
          bitcoin: { usd: 125, last_updated_at: now / 1000 + 3600 },
          ethereum: { usd: 5, last_updated_at: now / 1000 + 3600 },
          solana: { usd: 2, last_updated_at: now / 1000 + 3600 },
        };
        return { status: 200, headers: {}, bodyText: JSON.stringify(body) };
      },
    };
  }

  it("makes no requests unless the operator turns it on", async () => {
    const urls: string[] = [];
    const report = await syncAssetPrices(db, { env: {}, transport: fakeTransport(urls) });
    expect(report).toMatchObject({ status: "skipped", reason: "disabled", requests: 0 });
    expect(urls).toEqual([]);
  });

  it("backfills a bounded number of assets per run, then adds current prices", async () => {
    const env = { MARKET_ASSET_PRICE_MODE: "live" };
    const urls: string[] = [];
    const first = await syncAssetPrices(db, { env, transport: fakeTransport(urls) });
    expect(first).toMatchObject({ status: "completed", requests: 3, backfilled: ["crypto:btc", "crypto:eth"] });
    expect(first.inserted).toBe(8); // 3 history points each, plus a current price for both
    expect(urls.at(-1)).toContain("ids=bitcoin%2Cethereum");

    const second = await syncAssetPrices(db, { env, transport: fakeTransport(urls) });
    expect(second).toMatchObject({ status: "completed", requests: 2, backfilled: ["crypto:sol"] });
    expect(second.inserted).toBe(4); // Solana's history and current price; the others are already stored

    const failing: HttpTransport = { fetch: async () => ({ status: 429, headers: {}, bodyText: "" }) };
    expect(await syncAssetPrices(db, { env, transport: failing })).toMatchObject({ status: "failed", reason: "rate_limited" });
  });
});
