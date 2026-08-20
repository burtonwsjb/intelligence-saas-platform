import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  FixtureContentGenerator,
  MissingEvidenceError,
  UnconfiguredLlmContentGenerator,
  approveDraft,
  canonicalPrintingUrl,
  createTenantReport,
  escapeContentHtml,
  generateDraft,
  ingestTcgMarketRecord,
  member,
  organization,
  readMigrationSql,
  runContentPipeline,
  scoreAndPersist,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  tenant,
  user,
  withOrganizationContext,
  type Database,
} from "../index.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const seeded = await seedTcgIdentityFixtures(db);
  for (const record of tcgMarketFixtureRecords()) {
    await ingestTcgMarketRecord(db, record);
  }
  await scoreAndPersist(db, {
    printingId: seeded.printings.greninjaEnNormal.id,
    asOf: new Date("2026-01-04T00:00:00.000Z"),
  });
  return { db, seeded };
}

describe("content evidence and generation", () => {
  it("refuses generation without an evidence package", async () => {
    const { db } = await setup();
    await expect(
      generateDraft(db, {
        candidateId: "missing",
        evidenceId: "missing",
        outputType: "card_analysis",
      }),
    ).rejects.toThrow(MissingEvidenceError);
    const llm = new UnconfiguredLlmContentGenerator();
    await expect(llm.generate()).rejects.toThrow(/not configured/);
    expect(escapeContentHtml("<script>alert(1)</script>")).not.toContain("<script>");
  });

  it("builds evidence-backed card analysis that can be approved", async () => {
    const { db, seeded } = await setup();
    const result = await runContentPipeline(db, {
      outputType: "card_analysis",
      printingId: seeded.printings.greninjaEnNormal.id,
      generator: new FixtureContentGenerator(),
      approve: true,
      approvedBy: "operator",
      unsafeTitleSuffix: "<script>xss</script>",
    });
    expect(result.evidence.thin).toBe(false);
    expect(result.evidence.sources.length).toBeGreaterThanOrEqual(2);
    expect(result.draft.bodyHtml).not.toContain("<script>");
    expect(result.validation.passed).toBe(true);
    expect(result.publication?.status).toBe("approved");
    expect(result.publication?.robots).toBe("index");
    expect(result.publication?.indexable).toBe(true);
    expect(result.publication?.canonicalUrl).toBe(
      canonicalPrintingUrl({
        gameKey: String((result.evidence.identity as { gameKey: string }).gameKey),
        languageCode: result.evidence.languageCode,
        canonicalPrintingKey: String((result.evidence.identity as { canonicalPrintingKey: string }).canonicalPrintingKey),
      }),
    );
  });

  it("turns thin evidence into a non-indexable stub and noindexes duplicates", async () => {
    const { db, seeded } = await setup();
    const thin = await runContentPipeline(db, {
      outputType: "card_analysis",
      evidence: {
        printingId: seeded.printings.greninjaEnNormal.id,
        languageCode: "en",
        asOf: new Date("2026-01-04T00:00:00.000Z"),
        recommendation: "insufficient_data",
        snapshotId: null,
        scoreId: null,
        signals: [],
        sources: [],
        falsifiers: [],
        identity: {
          cardName: "Greninja",
          setName: "Twilight Masquerade",
          collectorNumber: "214/167",
          languageCode: "en",
          variantKey: "normal",
          gameKey: "pokemon",
          canonicalPrintingKey: "pokemon|greninja|twm|214167|en|normal",
        },
      },
      approve: true,
    });
    expect(thin.evidence.thin).toBe(true);
    expect(thin.validation.passed).toBe(true);
    expect(thin.publication?.robots).toBe("noindex");
    expect(thin.publication?.indexable).toBe(false);

    const first = await runContentPipeline(db, {
      outputType: "card_analysis",
      printingId: seeded.printings.greninjaEnNormal.id,
      approve: true,
    });
    const second = await runContentPipeline(db, {
      outputType: "card_analysis",
      printingId: seeded.printings.greninjaEnNormal.id,
      approve: true,
    });
    expect(first.publication?.indexable).toBe(true);
    expect(second.publication?.indexable).toBe(false);
    expect(second.publication?.robots).toBe("noindex");
    expect(second.publication?.canonicalUrl).not.toBe(first.publication?.canonicalUrl);
  });

  it("rejects approval when validation fails and keeps tenant reports off public SEO", async () => {
    const { db, seeded } = await setup();
    const ja = await runContentPipeline(db, {
      outputType: "card_analysis",
      evidence: {
        printingId: seeded.printings.greninjaEnNormal.id,
        languageCode: "ja",
        asOf: new Date("2026-01-04T00:00:00.000Z"),
        recommendation: "watch",
        snapshotId: "snap_en",
        scoreId: "score_en",
        comparative: false,
        signals: [{ key: "opportunity", magnitude: 70 }],
        sources: [
          { type: "market_snapshot", id: "snap_en" },
          { type: "score_snapshot", id: "score_en" },
        ],
        falsifiers: ["A Japanese sold print reversing the move would weaken this."],
        identity: {
          cardName: "Greninja",
          languageCode: "en",
          canonicalPrintingKey: "pokemon|greninja|twm|214167|en|normal",
          gameKey: "pokemon",
        },
      },
    });
    expect(ja.validation.passed).toBe(false);
    expect(ja.validation.failures).toEqual(expect.arrayContaining(["language_mismatch"]));
    await expect(approveDraft(db, { draftId: ja.draft.id })).rejects.toThrow(/Validation must pass/);

    await db.insert(user).values({ id: "user_content", name: "C", email: "c@example.com", emailVerified: true });
    await db.insert(organization).values({ id: "org_content", name: "C", slug: "org-content" });
    await db.insert(member).values({
      id: "mem_content",
      organizationId: "org_content",
      userId: "user_content",
      role: "owner",
    });
    await db.insert(tenant).values({
      organizationId: "org_content",
      status: "active",
      createdByUserId: "user_content",
    });
    const report = await withOrganizationContext(
      db,
      { organizationId: "org_content", userId: "user_content" },
      (scoped) =>
        createTenantReport(scoped, {
          organizationId: "org_content",
          title: "Holdings briefing",
          bodyText: "Private holdings summary.",
          holdings: [{ printingId: seeded.printings.greninjaEnNormal.id }],
        }),
    );
    expect(report.publicSeo).toBe(false);
  });
});
