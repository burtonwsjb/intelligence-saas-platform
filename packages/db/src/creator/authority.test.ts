import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  extractCreatorCallsFromContent,
  getCreatorAuthorityProfile,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  readMigrationSql,
  recordCreatorTrust,
  recomputeCreatorAuthority,
  evaluateCreatorCallOutcome,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "./fixtures.js";
import { authorityScore, bayesMean, wilsonInterval } from "./stats.js";

describe("creator authority statistics", () => {
  it("does not rank 4/4 above a well-supported 730/1000 on Wilson or authority.v1", () => {
    const small = wilsonInterval(4, 4);
    const large = wilsonInterval(730, 1000);
    expect(small.raw).toBeGreaterThan(large.raw);
    expect(small.low).toBeLessThan(large.low);
    expect(bayesMean(4, 4)).toBeLessThan(bayesMean(730, 1000));
    const smallScore = authorityScore({ wilsonLow: small.low, n: 4, avgReturn: 1 });
    const largeScore = authorityScore({ wilsonLow: large.low, n: 1000, avgReturn: 0.04 });
    expect(smallScore).toBeLessThan(largeScore);
  });
});

describe("creator outcomes and authority", () => {
  async function setup() {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    return { db, seeded };
  }

  async function extraSold(
    db: Database,
    seeded: Awaited<ReturnType<typeof seedTcgIdentityFixtures>>,
    input: { id: string; language: "en" | "ja"; price: number; at: string; currency?: string },
  ) {
    await ingestTcgMarketRecord(db, {
      provider: "tcg_card_central",
      provider_record_id: input.id,
      event_type: "tcg.market.sold",
      market_type: "marketplace_sold",
      price_type: "sold",
      observed_at: input.at,
      currency: input.currency ?? (input.language === "ja" ? "JPY" : "USD"),
      condition: "nm",
      price: input.price,
      quantity: 1,
      aggregation_kind: "event",
      printing: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: input.language,
        variant: "normal",
      },
    });
    return seeded;
  }

  it("evaluates horizons without look-ahead and scores contextual authority", async () => {
    const { db, seeded } = await setup();
    await extraSold(db, seeded, { id: "sold_en_future_ok", language: "en", price: 55, at: "2026-01-20T00:00:00.000Z" });
    await extraSold(db, seeded, { id: "sold_en_after_horizon", language: "en", price: 10, at: "2026-03-01T00:00:00.000Z" });
    await extraSold(db, seeded, { id: "sold_ja_future_ok", language: "ja", price: 9000, at: "2026-01-20T00:00:00.000Z", currency: "JPY" });
    await extraSold(db, seeded, { id: "sold_en_pre_move", language: "en", price: 20, at: "2025-12-28T00:00:00.000Z" });

    const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const sell = await ingestSourceContentRecord(db, {
      ...creatorCallSourceFixtures()[1]!,
      content: {
        ...creatorCallSourceFixtures()[1]!.content,
        summary: "Sell now overpriced. 30 days.",
        excerpt: "Sell now. English Twilight Masquerade Greninja 214 normal is overpriced. 30 days.",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:03:00",
          end_ref: "00:03:10",
          excerpt: "Sell now. English Twilight Masquerade Greninja 214 normal is overpriced. 30 days.",
        },
      ],
    });
    const ja = await ingestSourceContentRecord(db, {
      ...creatorCallSourceFixtures()[2]!,
      content: {
        ...creatorCallSourceFixtures()[2]!.content,
        excerpt: "Japanese Twilight Masquerade ゲッコウガ 214 normal は上がる。買う。30 days.",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:01:00",
          end_ref: "00:01:12",
          excerpt: "Japanese Twilight Masquerade ゲッコウガ 214 normal は上がる。買う。30 days.",
        },
      ],
    });
    const unresolved = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[5]!);
    const [buyCall] = await extractCreatorCallsFromContent(db, buy.contentId!);
    const [sellCall] = await extractCreatorCallsFromContent(db, sell.contentId!);
    const [jaCall] = await extractCreatorCallsFromContent(db, ja.contentId!);
    const [openCall] = await extractCreatorCallsFromContent(db, unresolved.contentId!);

    const asOf = new Date("2026-06-01T00:00:00.000Z");
    const buyOut = await evaluateCreatorCallOutcome(db, buyCall!.call!.id, asOf);
    const sellOut = await evaluateCreatorCallOutcome(db, sellCall!.call!.id, asOf);
    const jaOut = await evaluateCreatorCallOutcome(db, jaCall!.call!.id, asOf);
    const openOut = await evaluateCreatorCallOutcome(db, openCall!.call!.id, asOf);

    expect(buyOut?.evaluationStatus).toBe("evaluated");
    expect(Number(buyOut?.endingPrice)).toBe(55);
    expect(buyOut?.directionalCorrect).toBe("correct");
    expect(buyOut?.targetHit).toBe("miss");
    expect(Number(buyOut?.endingPrice)).not.toBe(10);
    expect(sellOut?.directionalCorrect).toBe("incorrect");
    expect(jaOut?.directionalCorrect).toBe("correct");
    expect(openOut?.evaluationStatus).toBe("insufficient_data");

    const missing = await evaluateCreatorCallOutcome(db, buyCall!.call!.id, new Date("2026-01-05T00:00:00.000Z"));
    expect(missing?.evaluationStatus).toBe("pending");
    await evaluateCreatorCallOutcome(db, buyCall!.call!.id, asOf);

    const slices = await recomputeCreatorAuthority(db, buyCall!.call!.creatorId, asOf);
    expect(slices.some((row) => row.languageCode === "en")).toBe(true);
    const jaSlices = await recomputeCreatorAuthority(db, jaCall!.call!.creatorId, asOf);
    expect(jaSlices.some((row) => row.languageCode === "ja")).toBe(true);
    expect(jaSlices.every((row) => row.avgRelativeReturn == null)).toBe(true);
    expect(jaSlices[0]?.benchmarkRequirement).toContain("phase_13");
    expect(jaSlices[0]?.components).toMatchObject({ buy_sell_signal: false });

    const profile = await getCreatorAuthorityProfile(db, buyCall!.call!.creatorId);
    expect(profile.buySellSignal).toBe(false);
    expect(profile.unresolved).toBeGreaterThanOrEqual(0);
    expect(profile.totalCalls).toBeGreaterThan(0);
    expect(Number(profile.headline?.authorityWeight ?? 0)).toBeGreaterThanOrEqual(0);

    await recordCreatorTrust(db, { creatorId: buyCall!.call!.creatorId, trustState: "excluded", reason: "test" });
    const excluded = await recomputeCreatorAuthority(db, buyCall!.call!.creatorId, asOf);
    expect(excluded.every((row) => row.trustState === "excluded")).toBe(true);
    const still = await getCreatorAuthorityProfile(db, buyCall!.call!.creatorId);
    expect(still.historicalCalls.length).toBeGreaterThan(0);
    expect(still.trustState).toBe("excluded");
  });

  it("does not score unresolved calls and marks missing market data", async () => {
    const { db } = await setup();
    const unresolved = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[5]!);
    const [call] = await extractCreatorCallsFromContent(db, unresolved.contentId!);
    const out = await evaluateCreatorCallOutcome(db, call!.call!.id, new Date("2026-06-01T00:00:00.000Z"));
    expect(call?.call?.printingId).toBeNull();
    expect(out?.evaluationStatus).toBe("insufficient_data");
    const slices = await recomputeCreatorAuthority(db, call!.call!.creatorId);
    const all = slices.find((row) => row.priceTier === "all");
    expect(Number(all?.sampleSize ?? 0)).toBe(0);
  });
});
