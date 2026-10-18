import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { seedTcgIdentityFixtures } from "./fixtures.js";
import { listSealedProducts, syncSealedProducts } from "./sealed.js";
import { extractAssetCallsFromContent, findAssetForTopic } from "../creator/assets.js";
import { scoreDueCreatorCalls } from "../creator/due.js";
import { AssetPriceInputError, ingestAssetPrice } from "../providers/asset-prices.js";
import { getTopicCalls } from "../topics/topics.js";

describe("sealed products", () => {
  let client: PGlite;
  let db: Database;

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await seedTcgIdentityFixtures(db);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("creates the standard products for each set, skips promo sets and keeps operator edits", async () => {
    const first = await syncSealedProducts(db);
    // Three Pokemon sets x 4 products, plus One Piece x 2; the promo set is skipped.
    expect(first.added).toBe(14);
    const twm = await listSealedProducts(db, { gameKey: "pokemon", setKey: "twm" });
    expect(twm.map((row) => row.displayName)).toEqual([
      "Twilight Masquerade Booster Pack",
      "Twilight Masquerade Booster Bundle",
      "Twilight Masquerade Booster Box",
      "Twilight Masquerade Elite Trainer Box",
    ]);
    await client.exec(`UPDATE market_asset SET status = 'paused' WHERE asset_key = 'sealed:pokemon:twm:booster_pack'`);
    expect((await syncSealedProducts(db)).added).toBe(0);
    expect((await listSealedProducts(db, { setKey: "twm" })).length).toBe(3);
    expect((await findAssetForTopic(db, "twilight masquerade etb"))?.assetKey).toBe("sealed:pokemon:twm:elite_trainer_box");
  });

  it("records marketplace prices with provenance and rejects bad input", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-06-01T00:00:00Z");
    const key = "sealed:pokemon:twm:booster_box";
    const point = { assetKey: key, sourceKey: "tcg_card_central", sourceRecordId: "bb_1", observedAt: at, price: 150, currency: "USD", now };
    expect(await ingestAssetPrice(db, point)).toEqual({ status: "inserted" });
    expect(await ingestAssetPrice(db, point)).toEqual({ status: "duplicate" });
    await expect(ingestAssetPrice(db, { ...point, price: -1 })).rejects.toThrow(AssetPriceInputError);
    await expect(ingestAssetPrice(db, { ...point, currency: "usd" })).rejects.toThrow(AssetPriceInputError);
    await expect(ingestAssetPrice(db, { ...point, observedAt: new Date("2026-07-01T00:00:00Z") })).rejects.toThrow(
      AssetPriceInputError,
    );
    await expect(ingestAssetPrice(db, { ...point, assetKey: "sealed:nope" })).rejects.toThrow(AssetPriceInputError);
  });

  it("turns a post about a booster box into a scored call", async () => {
    await ingestAssetPrice(db, {
      assetKey: "sealed:pokemon:twm:booster_box",
      sourceKey: "tcg_card_central",
      sourceRecordId: "bb_2",
      observedAt: new Date("2026-01-28T00:00:00Z"),
      price: 135,
      currency: "USD",
      now: new Date("2026-06-01T00:00:00Z"),
    });
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at)
        VALUES ('sa_box', 'youtube', 'UCbox', 'Box Breaker', now(), now());
      INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
        VALUES ('c_box', 'youtube', 'c_box', 'sa_box', '2026-01-01T06:00:00Z',
          'Twilight Masquerade booster box is overpriced, sell before it will drop. 30 days.', 'https://example.test/c_box', 'video', 'c_box');
    `);
    const results = await extractAssetCallsFromContent(db, "c_box");
    const [box] = (await listSealedProducts(db, { setKey: "twm" })).filter((row) => row.productType === "booster_box");
    expect(results.map((row) => row.assetId)).toEqual([box!.id]);
    await scoreDueCreatorCalls(db, { asOf: new Date("2026-02-15T00:00:00Z") });
    const calls = await getTopicCalls(db, box!.id);
    expect(calls).toMatchObject({ total: 1, evaluated: 1, correct: 1 });
  });
});
