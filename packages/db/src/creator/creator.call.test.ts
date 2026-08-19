import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  creatorCall,
  extractCreatorCallsFromContent,
  FixtureLlmCreatorCallExtractor,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  listCallsAwaitingOutcome,
  listCallsByCreator,
  listCallsByDirection,
  listCallsByPrinting,
  listUnresolvedCalls,
  readMigrationSql,
  reviseCreatorCall,
  seedTcgIdentityFixtures,
  sourceIntelligenceFixtures,
  tcgMarketFixtureRecords,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "./fixtures.js";
import { extractCallDeterministic } from "./extract.js";

describe("creator call extraction", () => {
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

  it("extracts bullish/bearish/buy/sell calls with targets, horizons, and no look-ahead price", async () => {
    const { db, seeded } = await setup();
    const fixtures = creatorCallSourceFixtures();
    const ingested = [];
    for (const record of fixtures) {
      ingested.push(await ingestSourceContentRecord(db, record));
    }
    const extracted = [];
    for (const row of ingested) {
      extracted.push(...(await extractCreatorCallsFromContent(db, row.contentId!)));
    }

    const buy = extracted.find((row) => row.call?.direction === "bullish" && row.call.targetPrice != null);
    expect(buy?.status).toBe("processed");
    expect(buy?.call?.printingId).toBe(seeded.printings.greninjaEnNormal.id);
    expect(buy?.call?.horizonCode).toBe("30d");
    expect(Number(buy?.call?.targetPrice)).toBe(100);
    expect(Number(buy?.call?.priceAtCall)).toBe(42);
    expect(buy?.call?.priceObservedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(buy?.call?.priceMethodVersion).toBe("price_at_call.v1");
    expect(buy?.call?.status).toBe("finalized");

    const sell = extracted.find((row) => row.call?.direction === "bearish");
    expect(sell?.call?.printingId).toBe(seeded.printings.greninjaEnNormal.id);

    const ja = extracted.find((row) => row.call?.printingId === seeded.printings.greninjaJaNormal.id);
    expect(ja?.call?.direction).toBe("bullish");
    expect(ja?.call?.priceCurrency).toBe("JPY");
    expect(ja?.call?.printingId).not.toBe(seeded.printings.greninjaEnNormal.id);

    const percent = extracted.find((row) => row.call?.targetPercent != null && row.call.horizonCode === "unspecified");
    expect(Number(percent?.call?.targetPercent)).toBe(20);

    const custom = extracted.find((row) => row.call?.horizonCode === "custom");
    expect(Number(custom?.call?.horizonCustomDays)).toBe(14);

    const unresolved = extracted.find((row) => row.call && row.call.printingId == null);
    expect(unresolved?.call?.resolutionStatus).toBe("unresolved");
    expect(unresolved?.call?.direction).toBe("bullish");

    const replay = await extractCreatorCallsFromContent(db, ingested[0]!.contentId!);
    expect(replay[0]?.status).toBe("duplicate");

    const byPrinting = await listCallsByPrinting(db, seeded.printings.greninjaEnNormal.id);
    expect(byPrinting.length).toBeGreaterThan(1);
    expect(await listCallsByDirection(db, "bearish")).toHaveLength(1);
    expect((await listUnresolvedCalls(db)).length).toBeGreaterThan(0);
    expect((await listCallsAwaitingOutcome(db)).every((row) => row.outcome.evaluationStatus === "pending")).toBe(true);
    expect((await listCallsByCreator(db, buy!.call!.creatorId)).length).toBeGreaterThan(1);
  });

  it("does not turn pull or price mentions into calls and keeps evidence/timestamps", async () => {
    const { db } = await setup();
    expect(extractCallDeterministic({ text: "this card exists" })).toBeNull();
    expect(extractCallDeterministic({ text: "I pulled this English Greninja 214 today.", mentionContext: "pull" })).toBeNull();
    expect(extractCallDeterministic({ text: "Price is $20", mentionContext: "price" })).toBeNull();
    expect(extractCallDeterministic({ text: "I would buy this" })?.direction).toBe("bullish");
    expect(extractCallDeterministic({ text: "sell now, overpriced" })?.direction).toBe("bearish");

    const reddit = await ingestSourceContentRecord(db, sourceIntelligenceFixtures()[2]!);
    const result = await extractCreatorCallsFromContent(db, reddit.contentId!);
    expect(result.every((row) => row.status === "not_a_call")).toBe(true);

    const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const calls = await extractCreatorCallsFromContent(db, buy.contentId!);
    expect(calls[0]?.call?.evidence).toMatchObject({ published_at: "2026-01-02T12:00:00.000Z" });
    expect(calls[0]?.call?.segmentId).toBeTruthy();
  });

  it("keeps finalized calls immutable and records audited revisions", async () => {
    const { db } = await setup();
    const ingested = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const [extracted] = await extractCreatorCallsFromContent(db, ingested.contentId!);
    await expect(
      db.update(creatorCall).set({ direction: "bearish" }).where(eq(creatorCall.id, extracted!.call!.id)),
    ).rejects.toThrow();
    const revised = await reviseCreatorCall(db, {
      callId: extracted!.call!.id,
      candidate: {
        is_call: true,
        direction: "watch",
        target_price: null,
        target_percent: null,
        horizon_code: "unspecified",
        horizon_custom_days: null,
        stated_confidence: null,
        extraction_confidence: 0.5,
        evidence: ["manual_revision"],
      },
      note: "reclassified",
    });
    expect(revised.call?.revisesCallId).toBe(extracted!.call!.id);
    expect(revised.call?.direction).toBe("watch");
    const original = await db.select().from(creatorCall).where(eq(creatorCall.id, extracted!.call!.id));
    expect(original[0]?.direction).toBe("bullish");
  });

  it("treats LLM extractor output as untrusted structured candidates", async () => {
    const { db } = await setup();
    const ingested = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const invalid = await extractCreatorCallsFromContent(
      db,
      ingested.contentId!,
      new FixtureLlmCreatorCallExtractor({ is_call: true, direction: "long" }),
    );
    expect(invalid[0]?.status).toBe("not_a_call");
    const valid = await extractCreatorCallsFromContent(
      db,
      ingested.contentId!,
      new FixtureLlmCreatorCallExtractor({
        is_call: true,
        direction: "bullish",
        horizon_code: "90d",
        extraction_confidence: 0.4,
        evidence: ["fixture_llm"],
      }),
    );
    expect(valid[0]?.status).toBe("processed");
    expect(valid[0]?.call?.horizonCode).toBe("90d");
  });
});
