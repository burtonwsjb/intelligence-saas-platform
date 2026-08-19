import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  computeCreatorAlpha,
  computeFeaturesFromSeries,
  computeIndexLevel,
  computeMarketFeatures,
  computeMarketFeaturesWithBenchmark,
  evaluateCreatorCallOutcome,
  extractCreatorCallsFromContent,
  getCreatorAuthorityProfile,
  getIndexDefinition,
  getIndexLevelAsOf,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  listMembershipAsOf,
  persistIndexLevel,
  persistMarketFeatureSnapshot,
  readMigrationSql,
  rebalanceIndex,
  recomputeCreatorAuthority,
  resolveBenchmark,
  seedTcgIdentityFixtures,
  tcgIndexLevel,
  tcgMarketFeatureSnapshot,
  tcgMarketFixtureRecords,
  upsertIndexDefinition,
  type Database,
  type TcgMarketRecordInput,
} from "../index.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import { MARKET_FEATURE_SET_VERSION, MARKET_RETURN_PERIODS } from "./catalog.js";

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

function printingRef(language: string, variant = "normal") {
  return {
    game: "pokemon",
    set: "twm",
    collector_number: "214/167",
    language,
    variant,
  };
}

async function sold(
  db: Database,
  input: {
    id: string;
    price: number;
    at: string;
    language?: string;
    variant?: string;
    currency?: string;
    condition?: string;
    set?: string;
    collector?: string;
    conceptPrinting?: TcgMarketRecordInput["printing"];
    quantity?: number;
  },
) {
  await ingestTcgMarketRecord(db, {
    provider: "fixture",
    provider_record_id: input.id,
    event_type: "tcg.market.sold",
    market_type: "marketplace_sold",
    price_type: "sold",
    observed_at: input.at,
    currency: input.currency ?? "USD",
    condition: input.condition ?? "nm",
    price: input.price,
    quantity: input.quantity ?? 1,
    aggregation_kind: "event",
    printing: input.conceptPrinting ?? printingRef(input.language ?? "en", input.variant ?? "normal"),
  });
}

async function listing(
  db: Database,
  input: { id: string; at: string; listingCount: number; sellerCount: number; low: number; language?: string },
) {
  await ingestTcgMarketRecord(db, {
    provider: "tcgplayer",
    provider_record_id: input.id,
    event_type: "tcg.market.listing_snapshot",
    market_type: "marketplace_listing",
    price_type: "asking",
    observed_at: input.at,
    currency: "USD",
    condition: "nm",
    listing_count: input.listingCount,
    seller_count: input.sellerCount,
    low_price: input.low,
    median_price: input.low + 2,
    high_price: input.low + 10,
    aggregation_kind: "window",
    window_seconds: 86400,
    printing: printingRef(input.language ?? "en"),
  });
}

describe("market feature formulas", () => {
  it("does not invent prices on a sparse series and never treats listings as sales", () => {
    const asOf = new Date("2026-01-03T00:00:00.000Z");
    const soldPoints = [
      { id: "a", observedAt: new Date("2026-01-01T00:00:00.000Z"), price: 40, quantity: 1, sourceKey: "fixture", outlierFlag: false, currency: "USD" },
      { id: "b", observedAt: new Date("2026-01-02T00:00:00.000Z"), price: 42, quantity: 1, sourceKey: "fixture", outlierFlag: false, currency: "USD" },
      { id: "c", observedAt: new Date("2026-01-03T00:00:00.000Z"), price: 41, quantity: 1, sourceKey: "fixture", outlierFlag: false, currency: "USD" },
    ];
    const features = computeFeaturesFromSeries({
      asOf,
      sold: soldPoints,
      listings: [
        {
          observedAt: new Date("2026-01-03T00:00:00.000Z"),
          listingCount: 12,
          sellerCount: 8,
          lowPrice: 39,
          medianPrice: 44,
          sourceKey: "tcgplayer",
        },
      ],
      outlierPolicy: "exclude_flagged.v1",
    });
    const returns = features.returns as Record<string, { status: string; value: number | null }>;
    expect(returns["1d"].status).toBe("ok");
    expect(returns["1d"].value).toBeCloseTo(41 / 42 - 1);
    expect(returns["7d"].status).toBe("insufficient_data");
    expect(returns["30d"].status).toBe("insufficient_data");
    expect(returns["365d"].value).toBeNull();
    const velocity = features.sales_velocity as { sales_7d: number };
    expect(velocity.sales_7d).toBe(3);
    expect(velocity.sales_7d).not.toBe(12);
  });

  it("computes moving stats, velocity, volatility, drawdown, and momentum on a high-volume series", () => {
    const asOf = new Date("2026-01-30T00:00:00.000Z");
    const start = Date.UTC(2025, 11, 22);
    const soldPoints = Array.from({ length: 40 }, (_, i) => {
      const observedAt = new Date(start + i * 86_400_000);
      return {
        id: `d${i}`,
        observedAt,
        price: 50 + i,
        quantity: 1,
        sourceKey: "fixture",
        outlierFlag: false,
        currency: "USD",
      };
    });
    const features = computeFeaturesFromSeries({
      asOf,
      sold: soldPoints,
      listings: [],
      outlierPolicy: "exclude_flagged.v1",
    });
    const returns = features.returns as Record<string, { status: string; value: number | null }>;
    expect(returns["1d"].status).toBe("ok");
    expect(returns["7d"].status).toBe("ok");
    expect(returns["30d"].status).toBe("ok");
    const rolling = features.rolling_median as { status: string; value: number | null };
    const sma = features.moving_average as { status: string; value: number | null };
    const ema = features.exponential_moving_average as { status: string; value: number | null };
    expect(rolling.status).toBe("ok");
    expect(sma.status).toBe("ok");
    expect(ema.status).toBe("ok");
    const velocity = features.sales_velocity as { sales_30d: number };
    expect(velocity.sales_30d).toBe(30);
    const vol = features.volatility as { status: string; method: string; sample_size: number };
    expect(vol.method).toBe("mad_trade_returns.v1");
    expect(vol.sample_size).toBeGreaterThan(2);
    const dd = features.drawdown as { status: string; value: number | null };
    expect(dd.status).toBe("ok");
    expect(dd.value).toBe(0);
    const momentum = features.momentum as { status: string };
    expect(momentum.status).toBe("ok");
  });

  it("flags supply reduction, listing/sale ratio, and outlier inclusion vs exclusion", () => {
    const asOf = new Date("2026-01-10T00:00:00.000Z");
    const base = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      observedAt: new Date(Date.UTC(2026, 0, i + 1)),
      price: 40,
      quantity: 1,
      sourceKey: "fixture",
      outlierFlag: false,
      currency: "USD",
    }));
    const outlier = {
      id: "spike",
      observedAt: new Date("2026-01-10T00:00:00.000Z"),
      price: 400,
      quantity: 1,
      sourceKey: "fixture",
      outlierFlag: true,
      currency: "USD",
    };
    const listings = [
      {
        observedAt: new Date("2026-01-03T00:00:00.000Z"),
        listingCount: 20,
        sellerCount: 10,
        lowPrice: 41,
        medianPrice: 42,
        sourceKey: "tcgplayer",
      },
      {
        observedAt: new Date("2026-01-10T00:00:00.000Z"),
        listingCount: 8,
        sellerCount: 4,
        lowPrice: 39,
        medianPrice: 40,
        sourceKey: "tcgplayer",
      },
    ];
    const excluded = computeFeaturesFromSeries({
      asOf,
      sold: [...base, outlier],
      listings,
      outlierPolicy: "exclude_flagged.v1",
    });
    const included = computeFeaturesFromSeries({
      asOf,
      sold: [...base, outlier],
      listings,
      outlierPolicy: "include_all.v1",
    });
    const supply = excluded.supply as { listing_change: number; listing_sale_ratio: { value: number | null } };
    expect(supply.listing_change).toBe(-12);
    expect(supply.listing_sale_ratio.value).not.toBeNull();
    expect(excluded.latest_sold_price).toBe(40);
    expect(included.latest_sold_price).toBe(400);
    const flags = excluded.manipulation_foundation as { outlier_driven: boolean };
    expect(flags.outlier_driven).toBe(true);
  });
});

describe("persisted analytics, indices, benchmarks, and alpha", () => {
  it("computes as-of features without look-ahead and exposes data quality", async () => {
    const { db, seeded } = await setup();
    await listing(db, { id: "list_pre", at: "2026-01-03T00:00:00.000Z", listingCount: 20, sellerCount: 9, low: 43 });
    const asOf = new Date("2026-01-03T12:00:00.000Z");
    const computed = await computeMarketFeatures(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf,
    });
    expect(computed.languageCode).toBe("en");
    const returns = computed.features.returns as Record<string, { status: string }>;
    expect(returns["1d"].status).toBe("ok");
    expect(returns["90d"].status).toBe("insufficient_data");
    expect(computed.features.manipulation_foundation).toBeTruthy();
    const persisted = await persistMarketFeatureSnapshot(db, computed);
    const again = await persistMarketFeatureSnapshot(db, computed);
    expect(again.id).toBe(persisted.id);
    await expect(
      db.update(tcgMarketFeatureSnapshot).set({ dataQuality: "stale" }).where(eq(tcgMarketFeatureSnapshot.id, persisted.id)),
    ).rejects.toThrow();

    await sold(db, { id: "future_leak", price: 12, at: "2026-02-01T00:00:00.000Z" });
    const recomputed = await computeMarketFeatures(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf,
    });
    expect(recomputed.features.latest_sold_price).toBe(computed.features.latest_sold_price);
    expect(recomputed.sampleSize).toBe(computed.sampleSize);
  });

  it("keeps English, Japanese, and zh-Hans indices separate and survivorship-safe", async () => {
    const { db, seeded } = await setup();
    await sold(db, {
      id: "pika_t1",
      price: 10,
      at: "2026-01-01T00:00:00.000Z",
      conceptPrinting: {
        game: "pokemon",
        set: "sv1",
        collector_number: "025/198",
        language: "en",
        variant: "normal",
      },
    });
    await sold(db, {
      id: "pika_t2_late",
      price: 11,
      at: "2026-01-02T00:00:00.000Z",
      conceptPrinting: {
        game: "pokemon",
        set: "sv1",
        collector_number: "025/198",
        language: "en",
        variant: "normal",
      },
    });
    const t1 = new Date("2026-01-03T00:00:00.000Z");
    const enMembers = await rebalanceIndex(db, "pokemon.language.en", t1);
    const jaMembers = await rebalanceIndex(db, "pokemon.language.ja", t1);
    const zhMembers = await rebalanceIndex(db, "pokemon.language.zh-Hans", t1);
    expect(enMembers.some((row) => row.printingId === seeded.printings.greninjaEnNormal.id)).toBe(true);
    expect(enMembers.some((row) => row.printingId === seeded.printings.pikachuSv1.id)).toBe(true);
    expect(enMembers.some((row) => row.printingId === seeded.printings.greninjaJaNormal.id)).toBe(false);
    expect(jaMembers.every((row) => row.printingId !== seeded.printings.greninjaEnNormal.id)).toBe(true);
    expect(jaMembers.some((row) => row.printingId === seeded.printings.greninjaJaNormal.id)).toBe(true);
    expect(zhMembers.some((row) => row.printingId === seeded.printings.greninjaZhNormal.id)).toBe(true);

    const enLevel = await persistIndexLevel(db, await computeIndexLevel(db, "pokemon.language.en", t1));
    const jaLevel = await persistIndexLevel(db, await computeIndexLevel(db, "pokemon.language.ja", t1));
    expect(Number(enLevel.indexValue)).toBe(100);
    expect(jaLevel.indexKey).toBe("pokemon.language.ja");
    expect(enLevel.indexKey).not.toBe(jaLevel.indexKey);

    await sold(db, {
      id: "char_t2",
      price: 80,
      at: "2026-02-10T00:00:00.000Z",
      conceptPrinting: {
        game: "pokemon",
        set: "sv1",
        collector_number: "006/198",
        language: "en",
        variant: "normal",
      },
    });
    await sold(db, { id: "gren_t2", price: 50, at: "2026-02-10T00:00:00.000Z" });
    const t2 = new Date("2026-02-12T00:00:00.000Z");
    const later = await rebalanceIndex(db, "pokemon.language.en", t2);
    expect(later.some((row) => row.printingId === seeded.printings.charizardStandard.id)).toBe(true);
    expect(later.some((row) => row.printingId === seeded.printings.pikachuSv1.id)).toBe(false);
    const historic = await listMembershipAsOf(db, "pokemon.language.en", t1);
    expect(historic.some((row) => row.printingId === seeded.printings.pikachuSv1.id)).toBe(true);
    const reconstructed = await computeIndexLevel(db, "pokemon.language.en", t1);
    expect(reconstructed.componentCount).toBe(enMembers.length);
    expect(reconstructed.componentCount).not.toBe(later.length);
  });

  it("resolves language-aware benchmarks, relative strength, and creator alpha without rewriting outcomes", async () => {
    const { db, seeded } = await setup();
    await sold(db, {
      id: "pika_alpha_1",
      price: 10,
      at: "2026-01-01T00:00:00.000Z",
      conceptPrinting: {
        game: "pokemon",
        set: "sv1",
        collector_number: "025/198",
        language: "en",
        variant: "normal",
      },
    });
    await sold(db, { id: "en_horizon", price: 50.4, at: "2026-02-01T00:00:00.000Z" });
    await sold(db, {
      id: "pika_alpha_2",
      price: 11.2,
      at: "2026-02-01T00:00:00.000Z",
      conceptPrinting: {
        game: "pokemon",
        set: "sv1",
        collector_number: "025/198",
        language: "en",
        variant: "normal",
      },
    });
    const callTime = new Date("2026-01-02T12:00:00.000Z");
    const horizon = new Date("2026-02-01T12:00:00.000Z");
    await rebalanceIndex(db, "pokemon.language.en", new Date("2026-01-01T00:00:00.000Z"));
    await rebalanceIndex(db, "pokemon.language.ja", callTime);
    await persistIndexLevel(db, await computeIndexLevel(db, "pokemon.language.en", callTime));
    await persistIndexLevel(db, await computeIndexLevel(db, "pokemon.language.en", horizon));
    await persistIndexLevel(db, await computeIndexLevel(db, "pokemon.language.ja", callTime));

    const en = await resolveBenchmark(db, {
      gameKey: "pokemon",
      languageCode: "en",
      setKey: "twm",
      era: "modern",
      asOf: callTime,
    });
    const ja = await resolveBenchmark(db, {
      gameKey: "pokemon",
      languageCode: "ja",
      asOf: callTime,
    });
    expect(en.status).toBe("ok");
    expect(en.indexKey).toBe("pokemon.language.en");
    expect(ja.indexKey).toBe("pokemon.language.ja");
    expect(en.indexKey).not.toBe(ja.indexKey);

    const custom = await upsertIndexDefinition(db, {
      indexKey: "pokemon.set.twm.en",
      name: "English TWM Index",
      gameKey: "pokemon",
      languageCode: "en",
      membershipRule: {
        game_key: "pokemon",
        language_code: "en",
        set_key: "twm",
        raw_graded: "raw",
        min_sales_30d: 1,
        min_history_observations: 1,
      },
    });
    expect(custom.indexKey).toBe("pokemon.set.twm.en");
    await rebalanceIndex(db, custom.indexKey, new Date("2026-01-01T00:00:00.000Z"));
    await persistIndexLevel(db, await computeIndexLevel(db, custom.indexKey, callTime));
    const tight = await resolveBenchmark(db, {
      gameKey: "pokemon",
      languageCode: "en",
      setKey: "twm",
      asOf: callTime,
    });
    expect(tight.indexKey).toBe("pokemon.set.twm.en");
    expect(tight.selection).toBe("set+language");

    const missing = await resolveBenchmark(db, {
      gameKey: "one_piece",
      languageCode: "en",
      asOf: callTime,
    });
    expect(missing.status).toBe("insufficient_benchmark");

    const featured = await computeMarketFeaturesWithBenchmark(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: horizon,
    });
    const rs = featured.features.relative_strength as { status: string };
    expect(["ok", "insufficient_data"]).toContain(rs.status);

    const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const [buyCall] = await extractCreatorCallsFromContent(db, buy.contentId!);
    const asOf = new Date("2026-06-01T00:00:00.000Z");
    const outcome = await evaluateCreatorCallOutcome(db, buyCall!.call!.id, asOf);
    expect(outcome?.evaluationStatus).toBe("evaluated");
    const rawReturn = outcome?.returnPct;
    const alpha = await computeCreatorAlpha(db, buyCall!.call!.id, asOf);
    expect(alpha.dataQuality).toBe("complete");
    expect(Number(alpha.cardReturn)).toBeCloseTo(Number(rawReturn));
    expect(Number(alpha.relativeReturn)).toBeCloseTo(Number(alpha.cardReturn) - Number(alpha.benchmarkReturn));
    const unchanged = await evaluateCreatorCallOutcome(db, buyCall!.call!.id, asOf);
    expect(unchanged?.returnPct).toBe(rawReturn);
    const slices = await recomputeCreatorAuthority(db, buyCall!.call!.creatorId, asOf);
    expect(slices.some((row) => row.avgRelativeReturn != null)).toBe(true);
    const profile = await getCreatorAuthorityProfile(db, buyCall!.call!.creatorId);
    expect(profile.buySellSignal).toBe(false);

    await expect(db.update(tcgIndexLevel).set({ dataQuality: "stale" }).where(eq(tcgIndexLevel.id, (await getIndexLevelAsOf(db, "pokemon.language.en", callTime))!.id))).rejects.toThrow();
    expect((await getIndexDefinition(db, "pokemon.language.en"))?.weightingMethod).toBe("equal.v1");
    expect(MARKET_RETURN_PERIODS).toHaveLength(6);
    expect(MARKET_FEATURE_SET_VERSION).toBe("features.v1");
  });

  it("supports 365d nearest observations and volume momentum sample gates", async () => {
    const { db, seeded } = await setup();
    await sold(db, { id: "y0", price: 20, at: "2025-01-01T12:00:00.000Z" });
    await sold(db, { id: "y1", price: 30, at: "2026-01-01T12:00:00.000Z" });
    const long = await computeMarketFeatures(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: new Date("2026-01-01T12:00:00.000Z"),
    });
    const returns = long.features.returns as Record<string, { status: string; value: number | null }>;
    expect(returns["365d"].status).toBe("ok");
    expect(returns["365d"].value).toBeCloseTo(30 / 20 - 1);
    await sold(db, { id: "vm1", price: 40, at: "2025-12-21T00:00:00.000Z" });
    await sold(db, { id: "vm2", price: 40, at: "2025-12-22T00:00:00.000Z" });
    const withPrior = await computeMarketFeatures(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: new Date("2026-01-03T00:00:00.000Z"),
    });
    const momentum = withPrior.features.volume_momentum as { status: string; sample_size: number };
    expect(momentum.status).toBe("ok");
    expect(momentum.sample_size).toBeGreaterThanOrEqual(4);
  });
});
