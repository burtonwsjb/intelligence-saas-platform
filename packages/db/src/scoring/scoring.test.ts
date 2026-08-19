import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  creatorConsensus,
  projectScoreToDecision,
  readMigrationSql,
  scoreAndPersist,
  scoreFromInputs,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  ingestTcgMarketRecord,
  tcgScoreSnapshot,
  withOrganizationContext,
  member,
  organization,
  tenant,
  user,
  type Database,
} from "../index.js";
import { SCORE_POLICY_VERSION } from "./weights.js";
import type { ScoreInputs } from "./model.js";

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
    returns: {
      "7d": { status: "ok", value: 0.07 },
      "30d": { status: "ok", value: 0.12 },
    },
    volumeMomentum: { status: "ok", value: 0.48 },
    salesVelocity: {
      sales_7d: 8,
      sales_30d: 24,
      sales_per_day_30d: { status: "ok", value: 0.8 },
      median_intersale_ms: { status: "ok", value: 86_400_000 },
    },
    supply: {
      listing_count: 10,
      listing_change: -4,
      seller_count: 7,
      absorption_ratio: { status: "ok", value: 0.8 },
    },
    relativeStrength: { status: "ok", value: 0.062 },
    volatility: { status: "ok", value: 0.04 },
    latestSpreadRatio: 1.05,
    manipulation: { thin_volume_spike: false, outlier_driven: false, supply_disappearance: false },
    ...overrides,
  };
}

describe("opportunity scoring model", () => {
  it("keeps opportunity, risk, confidence, and liquidity separate and explainable", () => {
    const scored = scoreFromInputs(baseInput());
    expect(scored.opportunity).not.toBe(scored.risk);
    expect(scored.confidence).not.toBe(scored.opportunity);
    expect(scored.liquidity).not.toBe(scored.risk);
    expect(scored.uncalibrated).toBe(true);
    expect(scored.explanations.length).toBeGreaterThan(3);
    expect(scored.explanations.some((line) => line.code === "volume_momentum")).toBe(true);
    expect(["buy", "strong_buy", "watch"]).toContain(scored.recommendation);
  });

  it("scores high opportunity / low risk as buy or strong_buy when the market confirms", () => {
    const scored = scoreFromInputs(baseInput());
    expect(scored.opportunity).toBeGreaterThan(60);
    expect(scored.risk).toBeLessThan(50);
    expect(["buy", "strong_buy"]).toContain(scored.recommendation);
  });

  it("does not emit strong_buy when opportunity is high but risk is high", () => {
    const scored = scoreFromInputs(
      baseInput({
        volatility: { status: "ok", value: 0.4 },
        latestSpreadRatio: 1.8,
        manipulation: { thin_volume_spike: true, outlier_driven: true, supply_disappearance: true },
        sampleSize: 4,
      }),
    );
    expect(scored.opportunity).toBeGreaterThan(50);
    expect(scored.risk).toBeGreaterThan(50);
    expect(scored.recommendation).not.toBe("strong_buy");
  });

  it("treats low liquidity separately from high price", () => {
    const scored = scoreFromInputs(
      baseInput({
        salesVelocity: {
          sales_7d: 1,
          sales_30d: 2,
          sales_per_day_30d: { status: "ok", value: 0.05 },
          median_intersale_ms: { status: "ok", value: 20 * 86_400_000 },
        },
        supply: { listing_count: 1, seller_count: 1, listing_change: 0, absorption_ratio: { status: "insufficient_data", value: null } },
        latestSpreadRatio: 2,
      }),
    );
    expect(scored.liquidity).toBeLessThan(40);
    expect(scored.recommendation).not.toBe("strong_buy");
  });

  it("blocks Strong Buy when social hype is unconfirmed by sales", () => {
    const scored = scoreFromInputs(
      baseInput({
        salesVelocity: {
          sales_7d: 1,
          sales_30d: 8,
          sales_per_day_30d: { status: "ok", value: 0.2 },
        },
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
    expect(scored.components.hype_unconfirmed).toBe(true);
    expect(scored.opportunity).toBeLessThanOrEqual(55);
    expect(scored.recommendation).not.toBe("strong_buy");
    expect(scored.recommendation).not.toBe("buy");
    expect(scored.explanations.some((line) => line.code === "hype_unconfirmed")).toBe(true);
  });

  it("weights creator consensus by authority so 4/4 cannot dominate 730/1000", () => {
    const weak = { creatorId: "small", direction: "bearish", languageCode: "en", authorityWeight: 0.08, sampleSize: 4, publishedAt: "2026-01-01T00:00:00.000Z" };
    const strong = { creatorId: "large", direction: "bullish", languageCode: "en", authorityWeight: 0.62, sampleSize: 1000, publishedAt: "2026-01-01T00:00:00.000Z" };
    const consensus = creatorConsensus([weak, strong], "en");
    expect(consensus.present).toBe(true);
    expect(consensus.raw).toBeGreaterThan(0);
    const scored = scoreFromInputs(baseInput({ creatorVotes: [weak, strong] }));
    expect(scored.explanations.some((line) => line.text.includes("bullish"))).toBe(true);
    const weakOnly = creatorConsensus([weak], "en");
    expect(weakOnly.total_weight).toBeLessThan(consensus.total_weight);
  });

  it("does not let a weak creator sample fabricate consensus", () => {
    const scored = scoreFromInputs(
      baseInput({
        creatorVotes: [
          { creatorId: "tiny", direction: "bullish", languageCode: "en", authorityWeight: 0.01, sampleSize: 4, publishedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    const component = scored.components.opportunity.find((row) => row.key === "creator_consensus");
    expect(component?.present).toBe(false);
    expect(component?.skipped_reason).toBe("weak_creator_sample");
    expect(component?.applied_weight).toBe(0);
  });

  it("keeps English and Japanese creator votes independent", () => {
    const votes = [
      { creatorId: "en", direction: "bullish", languageCode: "en", authorityWeight: 0.5, sampleSize: 40, publishedAt: "2026-01-01T00:00:00.000Z" },
      { creatorId: "ja", direction: "bearish", languageCode: "ja", authorityWeight: 0.5, sampleSize: 40, publishedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(creatorConsensus(votes, "en").raw).toBeGreaterThan(0);
    expect(creatorConsensus(votes, "ja").raw).toBeLessThan(0);
  });

  it("uses insufficient_data when sample and confidence gates fail", () => {
    const scored = scoreFromInputs(
      baseInput({
        sampleSize: 1,
        dataQuality: "insufficient_data",
        returns: { "7d": { status: "insufficient_data", value: null } },
        volumeMomentum: { status: "insufficient_data", value: null },
        salesVelocity: { sales_7d: 1, sales_30d: 1 },
      }),
    );
    expect(scored.recommendation).toBe("insufficient_data");
  });

  it("does not substitute missing values as zeros", () => {
    const scored = scoreFromInputs(
      baseInput({
        volumeMomentum: { status: "insufficient_data", value: null },
        relativeStrength: { status: "insufficient_data", value: null },
        social: null,
        creatorVotes: [],
      }),
    );
    const volume = scored.components.opportunity.find((row) => row.key === "volume_momentum");
    expect(volume?.present).toBe(false);
    expect(volume?.contribution).toBeNull();
    expect(volume?.applied_weight).toBe(0);
    const present = scored.components.opportunity.filter((row) => row.present);
    const applied = present.reduce((sum, row) => sum + row.applied_weight, 0);
    expect(applied).toBeCloseTo(1);
  });

  it("distinguishes high vs low confidence", () => {
    const high = scoreFromInputs(baseInput({ sampleSize: 40, sourceCount: 3, stalenessHours: 2 }));
    const low = scoreFromInputs(baseInput({ sampleSize: 3, sourceCount: 1, stalenessHours: 24 * 40, resolutionCertainty: 0.2 }));
    expect(high.confidence).toBeGreaterThan(low.confidence);
  });
});

describe("persisted scores and decision records", () => {
  it("creates a new immutable snapshot when the score version changes and projects a decision", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    const asOf = new Date("2026-01-04T00:00:00.000Z");
    const first = await scoreAndPersist(db, { printingId: seeded.printings.greninjaEnNormal.id, asOf });
    const second = await scoreAndPersist(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf,
      scoreVersion: "score.v1-test",
    });
    expect(first.id).not.toBe(second.id);
    expect(first.scoreVersion).toBe(SCORE_POLICY_VERSION);
    expect(second.scoreVersion).toBe("score.v1-test");
    expect(Number(first.opportunityScore)).not.toBe(Number(first.riskScore));
    await expect(
      db.update(tcgScoreSnapshot).set({ recommendation: "buy" }).where(eq(tcgScoreSnapshot.id, first.id)),
    ).rejects.toThrow();

    await db.insert(user).values({ id: "user_score", name: "S", email: "s@example.com", emailVerified: true });
    await db.insert(organization).values({ id: "org_score", name: "S", slug: "org-score" });
    await db.insert(member).values({ id: "mem_score", organizationId: "org_score", userId: "user_score", role: "owner" });
    await db.insert(tenant).values({ organizationId: "org_score", status: "active", createdByUserId: "user_score" });
    const link = await withOrganizationContext(db, { organizationId: "org_score", userId: "user_score" }, (scoped) =>
      projectScoreToDecision(scoped, { organizationId: "org_score", scoreId: first.id }),
    );
    expect(link?.id).toBeTruthy();
    expect((link?.result as { recommendation?: string }).recommendation).toBe(first.recommendation);
    const replay = await withOrganizationContext(db, { organizationId: "org_score", userId: "user_score" }, (scoped) =>
      projectScoreToDecision(scoped, { organizationId: "org_score", scoreId: first.id }),
    );
    expect(replay?.id).toBe(link?.id);
  });
});
