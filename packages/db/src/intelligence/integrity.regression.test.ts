import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { parseMoneyDecimal } from "@isp/shared";
import {
  computeFeaturesFromSeries,
  creatorConsensus,
  issuePrediction,
  readMigrationSql,
  resolveEntity,
  scoreAndPersist,
  scoreFromInputs,
  scorePrinting,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  ingestTcgMarketRecord,
  tcgPrediction,
  type Database,
} from "../index.js";
import type { ScoreInputs } from "../scoring/model.js";
import {
  INTELLIGENCE_INVARIANTS,
  INTELLIGENCE_REGRESSION_SCENARIOS,
  assertExplainableScore,
  assertShadowPrediction,
} from "./integrity.js";

function baseInput(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    printingId: "prn_en",
    languageCode: "en",
    asOf: "2026-01-30T00:00:00.000Z",
    sampleSize: 20,
    dataQuality: "complete",
    stalenessHours: 12,
    sourceCount: 2,
    resolutionCertainty: 1,
    returns: { "7d": { status: "ok", value: 0.07 }, "30d": { status: "ok", value: 0.12 } },
    volumeMomentum: { status: "ok", value: 0.48 },
    salesVelocity: {
      sales_7d: 8,
      sales_30d: 24,
      sales_per_day_30d: { status: "ok", value: 0.8 },
    },
    supply: { listing_count: 10, listing_change: -4, seller_count: 7, absorption_ratio: { status: "ok", value: 0.8 } },
    relativeStrength: { status: "ok", value: 0.062 },
    volatility: { status: "ok", value: 0.04 },
    latestSpreadRatio: 1.05,
    manipulation: { thin_volume_spike: false, outlier_driven: false, supply_disappearance: false },
    ...overrides,
  };
}

describe("intelligence regression catalog", () => {
  it("covers every required scenario name", () => {
    expect(INTELLIGENCE_REGRESSION_SCENARIOS).toHaveLength(14);
    expect(INTELLIGENCE_INVARIANTS.predictionsRemainShadow).toBe(true);
    expect(INTELLIGENCE_INVARIANTS.mixedCurrencyFailsClosed).toBe(true);
  });

  it("normal market stays explainable and uncalibrated", () => {
    const scored = scoreFromInputs(baseInput());
    assertExplainableScore(scored);
    expect(scored.uncalibrated).toBe(true);
    expect(scored.explanations.length).toBeGreaterThan(3);
    expect(["buy", "strong_buy", "watch"]).toContain(scored.recommendation);
  });

  it("thin market lowers liquidity and blocks strong_buy", () => {
    const scored = scoreFromInputs(
      baseInput({
        sampleSize: 3,
        salesVelocity: { sales_7d: 1, sales_30d: 2, sales_per_day_30d: { status: "ok", value: 0.05 } },
        supply: { listing_count: 1, seller_count: 1, listing_change: 0, absorption_ratio: { status: "insufficient_data", value: null } },
        latestSpreadRatio: 2.1,
      }),
    );
    assertExplainableScore(scored);
    expect(scored.liquidity).toBeLessThan(40);
    expect(scored.recommendation).not.toBe("strong_buy");
  });

  it("outlier-driven and manipulated spikes raise risk", () => {
    const scored = scoreFromInputs(
      baseInput({
        volatility: { status: "ok", value: 0.45 },
        latestSpreadRatio: 1.9,
        manipulation: { thin_volume_spike: true, outlier_driven: true, supply_disappearance: true, price_jump_without_volume: true },
        sampleSize: 4,
      }),
    );
    assertExplainableScore(scored);
    expect(scored.risk).toBeGreaterThan(50);
    expect(scored.recommendation).not.toBe("strong_buy");
  });

  it("mixed currencies fail closed instead of averaging", () => {
    const features = computeFeaturesFromSeries({
      asOf: new Date("2026-01-03T00:00:00.000Z"),
      sold: [
        { id: "usd", observedAt: new Date("2026-01-01T00:00:00.000Z"), price: 40, quantity: 1, sourceKey: "fixture", outlierFlag: false, currency: "USD" },
        { id: "jpy", observedAt: new Date("2026-01-02T00:00:00.000Z"), price: 8000, quantity: 1, sourceKey: "fixture", outlierFlag: false, currency: "JPY" },
      ],
      listings: [],
      outlierPolicy: "exclude_flagged.v1",
    });
    const returns = features.returns as Record<string, { status: string; value: number | null }>;
    expect(returns["1d"].status).toBe("insufficient_data");
    expect(features.latest_sold_price).toBeNull();
  });

  it("viral social without sales is not treated as market confirmation", () => {
    const scored = scoreFromInputs(
      baseInput({
        salesVelocity: { sales_7d: 1, sales_30d: 8, sales_per_day_30d: { status: "ok", value: 0.2 } },
        social: {
          mentions_7d: 40,
          mentions_prior_7d: 2,
          unique_accounts: 20,
          unique_content: 18,
          engagement_sum: 80_000,
          language_code: "en",
        },
      }),
    );
    assertExplainableScore(scored);
    expect(scored.components.hype_unconfirmed).toBe(true);
    expect(scored.recommendation).not.toBe("buy");
    expect(scored.recommendation).not.toBe("strong_buy");
  });

  it("stale social does not outrank a confirmed market move", () => {
    const scored = scoreFromInputs(
      baseInput({
        social: {
          mentions_7d: 1,
          mentions_prior_7d: 20,
          unique_accounts: 2,
          unique_content: 1,
          engagement_sum: 10,
          language_code: "en",
        },
      }),
    );
    assertExplainableScore(scored);
    expect(["buy", "strong_buy", "watch"]).toContain(scored.recommendation);
  });

  it("market move without social still scores from market evidence", () => {
    const scored = scoreFromInputs(baseInput({ social: null, creatorVotes: [] }));
    assertExplainableScore(scored);
    expect(scored.opportunity).toBeGreaterThan(50);
  });

  it("conflicting creators are authority-weighted and language-separated", () => {
    const votes = [
      { creatorId: "small", direction: "bearish", languageCode: "en", authorityWeight: 0.08, sampleSize: 4, publishedAt: "2026-01-01T00:00:00.000Z" },
      { creatorId: "large", direction: "bullish", languageCode: "en", authorityWeight: 0.62, sampleSize: 1000, publishedAt: "2026-01-01T00:00:00.000Z" },
      { creatorId: "ja", direction: "bearish", languageCode: "ja", authorityWeight: 0.5, sampleSize: 40, publishedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(creatorConsensus(votes, "en").raw).toBeGreaterThan(0);
    expect(creatorConsensus(votes, "ja").raw).toBeLessThan(0);
    const scored = scoreFromInputs(baseInput({ creatorVotes: votes }));
    assertExplainableScore(scored);
  });
});

describe("persisted intelligence integrity", () => {
  it("keeps language, variant, grading, outliers, and shadow predictions intact", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }

    const en = seeded.printings.greninjaEnNormal.id;
    const ja = seeded.printings.greninjaJaNormal.id;
    const holo = seeded.printings.greninjaEnHolo.id;
    expect(en).not.toBe(ja);
    expect(en).not.toBe(holo);

    const ambiguous = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "name_only_pikachu",
      signals: { game: "pokemon", card_name: "Pikachu", context_text: "Pikachu is going crazy" },
    });
    expect(ambiguous.attempt.chosenPrintingId).toBeNull();

    const acrossSets = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "same_number_sets",
      signals: { game: "pokemon", collector_number: "025", card_name: "Pikachu" },
    });
    expect(acrossSets.attempt.status).not.toBe("exact");

    const computed = await scorePrinting(db, {
      printingId: en,
      asOf: new Date("2026-01-04T12:00:00.000Z"),
    });
    assertExplainableScore(computed);
    const scored = await scoreAndPersist(db, {
      printingId: en,
      asOf: new Date("2026-01-04T12:00:00.000Z"),
    });
    expect(scored.recommendation).toBe(computed.recommendation);

    const prediction = await issuePrediction(db, {
      printingId: en,
      horizon: "30d",
      issuedAt: new Date("2026-01-04T12:00:00.000Z"),
    });
    assertShadowPrediction(prediction);
    const published = await db.select().from(tcgPrediction);
    expect(published.every((row) => row.visibility === "shadow")).toBe(true);

    await expect(
      issuePrediction(db, {
        printingId: en,
        horizon: "30d",
        issuedAt: new Date("2026-01-04T12:00:00.000Z"),
        dataCutoffAt: new Date("2026-01-05T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/cutoff/i);

    const late = tcgMarketFixtureRecords().find((row) => parseMoneyDecimal(String(row.price ?? "0")) === "4000");
    expect(late).toBeTruthy();
  });
});
