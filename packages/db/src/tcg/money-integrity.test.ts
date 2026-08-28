import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { formatMoney, parseMoneyDecimal } from "@isp/shared";
import {
  getPrintingWorkspace,
  ingestTcgMarketRecord,
  listLatestOpportunities,
  parsePositiveAmount,
  readMigrationSql,
  scoreAndPersist,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
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
  return { db, seeded };
}

describe("market money integrity", () => {
  it("persists $40.00 and $4,000.00 as major units without cents conversion", () => {
    expect(parsePositiveAmount(40, "price")).toBe("40");
    expect(parsePositiveAmount("40.00", "price")).toBe("40");
    expect(parsePositiveAmount(4000, "price")).toBe("4000");
    expect(parsePositiveAmount("4000.00000000", "price")).toBe("4000");
    expect(parseMoneyDecimal(parsePositiveAmount(40, "price")!)).not.toBe("4000");
  });

  it("stores fixture Greninja comps at $40–$42 and the named outlier at $4,000", async () => {
    const { db, seeded } = await setup();
    const workspace = await getPrintingWorkspace(db, seeded.printings.greninjaEnNormal.id);
    expect(workspace?.latestSold?.price).toBeTruthy();
    expect(parseMoneyDecimal(workspace!.latestSold!.price!)).toBe("41");
    expect(workspace!.latestSold!.currency).toBe("USD");
    expect(workspace!.latestObservedSold?.outlierFlag).toBe(true);
    expect(parseMoneyDecimal(workspace!.latestObservedSold!.price!)).toBe("4000");
    const ja = await getPrintingWorkspace(db, seeded.printings.greninjaJaNormal.id);
    expect(parseMoneyDecimal(ja!.latestSold!.price!)).toBe("8000");
    expect(ja!.latestSold!.currency).toBe("JPY");
  });

  it("shows opportunity list price as the latest non-outlier sold, formatted as USD", async () => {
    const { db, seeded } = await setup();
    await scoreAndPersist(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: new Date("2026-01-04T12:00:00.000Z"),
    });
    const rows = await listLatestOpportunities(db);
    const greninja = rows.find((row) => row.identity.printingId === seeded.printings.greninjaEnNormal.id);
    expect(greninja?.market?.currency).toBe("USD");
    expect(parseMoneyDecimal(greninja!.market!.price!)).toBe("41");
    expect(formatMoney(greninja!.market!.price, greninja!.market!.currency)).toBe("$41.00");
    expect(formatMoney("4000.00000000", "USD")).toBe("$4,000.00");
  });

  it("is idempotent when fixture market records are ingested twice", async () => {
    const { db, seeded } = await setup();
    for (const record of tcgMarketFixtureRecords()) {
      const again = await ingestTcgMarketRecord(db, record);
      expect(again.status === "processed" || again.status === "duplicate").toBe(true);
    }
    const workspace = await getPrintingWorkspace(db, seeded.printings.greninjaEnNormal.id);
    expect(workspace?.sold.filter((row) => parseMoneyDecimal(row.price ?? "0") === "4000")).toHaveLength(1);
    expect(workspace?.sold.filter((row) => parseMoneyDecimal(row.price ?? "0") === "41")).toHaveLength(1);
  });
});
