import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../client.js";
import { readMigrationSql } from "../../migrations.js";
import { seedTcgIdentityFixtures } from "../../tcg/fixtures.js";
import { CHART_PATTERNS } from "./patterns.js";
import { chartSentimentBatchSize, getChartSentiment, listChartPatterns, runChartSentimentBatch } from "./store.js";

describe("chart sentiment storage", () => {
  let client: PGlite;
  let db: Database;
  let raw: string;
  let thin: string;
  const asOf = new Date("2026-09-08T18:00:00.000Z");

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    raw = seeded.printings.greninjaEnNormal.id;
    thin = seeded.printings.greninjaJaNormal.id;
    // 250 days of a rising raw reference price, 70 days of falling PSA 10 sales
    // with sales counts and population, and only 10 days for another printing.
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price, source_record_id, fingerprint)
       SELECT 'r' || g, $1, 'tcg_card_central', 'market_price', 'reference', timestamptz '2026-01-01 12:00Z' + g * interval '1 day',
         'USD', 'nm', round((10 * power(1.004, g))::numeric, 2), 'r' || g, 'r' || g
       FROM generate_series(0, 249) g`,
      [raw],
    );
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition,
         grading_company, grade_numeric, price, sales_count, source_record_id, fingerprint, attributes)
       SELECT 'g' || g, $1, 'ebay', 'marketplace_sold', 'sold', timestamptz '2026-07-01 12:00Z' + g * interval '1 day', 'USD', 'nm',
         'psa', 10, 200 - g, CASE WHEN g > 50 THEN 1 ELSE 3 END, 'g' || g, 'g' || g, jsonb_build_object('population', 1000 + g * 5)
       FROM generate_series(0, 69) g`,
      [raw],
    );
    // An outlier is never read.
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price,
         source_record_id, fingerprint, outlier_flag)
       VALUES ('outlier', $1, 'tcg_card_central', 'market_price', 'reference', '2026-09-07 18:00Z', 'USD', 'nm', 9999, 'outlier', 'outlier', true)`,
      [raw],
    );
    await client.query(
      `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price, source_record_id, fingerprint)
       SELECT 'q' || g, $1, 'tcg_card_central', 'market_price', 'reference', timestamptz '2026-08-20 12:00Z' + g * interval '1 day',
         'USD', 'nm', 5, 'q' || g, 'q' || g
       FROM generate_series(0, 9) g`,
      [thin],
    );
  });

  it("scores raw and each grade separately, stores them and serves them in one read", async () => {
    const report = await runChartSentimentBatch(db, { asOf, batchSize: 10 });
    expect(report).toMatchObject({ status: "completed", considered: 2, printings: 2, segments: 3, failed: 0 });
    const stored = await getChartSentiment(db, [raw, thin, "missing"]);
    expect(stored.has("missing")).toBe(false);
    const card = stored.get(raw)!;
    expect(card.raw).toMatchObject({ segment: "raw", label: "bullish", points: 250, dataThrough: "2026-09-07", priceType: "reference" });
    expect(card.raw!.lastPrice! < 100).toBe(true);
    expect(card.raw!.signals.map((s) => s.key)).toContain("uptrend");
    expect(card.raw!.signals[0]!.explanation.length > 10).toBe(true);
    expect(card.graded.map((g) => g.segment)).toEqual(["psa10"]);
    expect(card.graded[0]).toMatchObject({ gradingCompany: "psa", grade: "10", label: "bearish", priceType: "sold" });
    expect(card.graded[0]!.signals.map((s) => s.key)).toContain("demand_falling");
    expect(stored.get(thin)!.raw).toMatchObject({ label: "insufficient_history", score: null, points: 10 });
  });

  it("keeps the pattern database in step with the catalog and measures hit rates", async () => {
    const patterns = await listChartPatterns(db);
    expect(patterns.length).toBe(CHART_PATTERNS.length);
    const uptrend = patterns.find((p) => p.key === "uptrend")!;
    expect(uptrend.samples > 0).toBe(true);
    expect(Number(uptrend.measured_hit_rate)).toBe(Number((uptrend.hits / uptrend.samples).toFixed(4)));
  });

  it("is idempotent and recomputes a printing only after the recompute interval", async () => {
    const again = await runChartSentimentBatch(db, { asOf: new Date(asOf.getTime() + 3_600_000), batchSize: 10 });
    expect(again).toMatchObject({ considered: 0, printings: 0 });
    const later = await runChartSentimentBatch(db, { asOf: new Date(asOf.getTime() + 21 * 3_600_000), batchSize: 1 });
    expect(later).toMatchObject({ considered: 1, printings: 1 });
    const rows = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM chart_sentiment`);
    expect(rows.rows[0]!.n).toBe(3);
  });

  it("reads the batch size from env and turns off at 0", async () => {
    expect(chartSentimentBatchSize({})).toBe(200);
    expect(chartSentimentBatchSize({ CHART_SENTIMENT_BATCH_SIZE: "0" })).toBe(0);
    expect(() => chartSentimentBatchSize({ CHART_SENTIMENT_BATCH_SIZE: "-1" })).toThrow();
    expect(await runChartSentimentBatch(db, { batchSize: 0 })).toMatchObject({ status: "skipped", reason: "disabled" });
  });

  it("skips and reads empty before migration 0033 is applied", async () => {
    const bare = new PGlite();
    const bareDb = drizzle(bare) as unknown as Database;
    await bare.exec(`CREATE TABLE tcg_market_snapshot (id text)`);
    expect(await runChartSentimentBatch(bareDb, { batchSize: 5 })).toMatchObject({ status: "skipped", reason: "tables_missing" });
    expect((await getChartSentiment(bareDb, ["x"])).size).toBe(0);
  });
});
