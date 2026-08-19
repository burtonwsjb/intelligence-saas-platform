import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import {
  entity,
  observation,
  signal,
  featureSnapshot,
  decisionRecord,
} from "../schema/kernel.js";
import {
  TcgMarketRevisionError,
  TcgMarketValidationError,
  computeDailyReturns,
  fixtureEbayMarketProvider,
  fixtureTcgCardCentralMarketProvider,
  fixtureTcgplayerMarketProvider,
  getLatestTcgMarketSnapshot,
  getTcgAskSoldSpread,
  ingestTcgMarketRecord,
  listObservationMetrics,
  listTcgListingHistory,
  listTcgMarketQuarantine,
  listTcgSoldHistory,
  listWindow,
  member,
  organization,
  projectTcgMarketSnapshotToTenant,
  readMigrationSql,
  receiveTcgMarketRecord,
  normalizeTcgMarketIngest,
  seedTcgIdentityFixtures,
  summarizeTcgLiquidityInputs,
  tcgMarketFixtureRecords,
  tenant,
  user,
  withOrganizationContext,
  type Database,
  type TcgMarketRecordInput,
} from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function seedOrg(db: Database) {
  await db.insert(user).values({
    id: "user_mkt",
    name: "M",
    email: "m@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({ id: "org_mkt", name: "M", slug: "org-mkt" });
  await db.insert(member).values({
    id: "mem_mkt",
    organizationId: "org_mkt",
    userId: "user_mkt",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_mkt",
    status: "active",
    createdByUserId: "user_mkt",
  });
}

function sold(overrides: Partial<TcgMarketRecordInput> = {}): TcgMarketRecordInput {
  return {
    provider: "fixture",
    provider_record_id: "sold_custom",
    event_type: "tcg.market.sold",
    market_type: "marketplace_sold",
    price_type: "sold",
    observed_at: "2026-01-01T00:00:00.000Z",
    currency: "USD",
    condition: "nm",
    price: 40,
    quantity: 1,
    printing: {
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "en",
      variant: "normal",
    },
    ...overrides,
  };
}

describe("TCG market history", () => {
  it("keeps TCG market fields off generic kernel tables", () => {
    const forbidden = ["collectorNumber", "languageCode", "variantKey", "cardName", "gradingCompany"];
    for (const table of [entity, observation, signal, featureSnapshot, decisionRecord]) {
      const columns = Object.keys(getTableColumns(table));
      for (const name of forbidden) {
        expect(columns).not.toContain(name);
      }
    }
  });

  it("ingests sold, listing, and reference snapshots bound to exact printings", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await seedOrg(db);
    const seeded = await seedTcgIdentityFixtures(db);
    const records = tcgMarketFixtureRecords();

    for (const record of records) {
      const result = await ingestTcgMarketRecord(db, record);
      expect(["processed", "duplicate"]).toContain(result.status);
      expect(result.snapshotId).toBeTruthy();
    }

    const replay = await ingestTcgMarketRecord(db, records[0]!);
    expect(replay.status).toBe("duplicate");

    const en = seeded.printings.greninjaEnNormal.id;
    const ja = seeded.printings.greninjaJaNormal.id;
    const zh = seeded.printings.greninjaZhNormal.id;
    const holo = seeded.printings.greninjaEnHolo.id;

    const enSold = await listTcgSoldHistory(db, { printingId: en, currency: "USD", condition: "nm" });
    expect(enSold.some((row) => Number(row.price) === 40)).toBe(true);
    expect(enSold.every((row) => row.printingId === en)).toBe(true);
    expect(enSold.map((row) => row.observedAt.toISOString()).join()).toBe(
      [...enSold]
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
        .map((row) => row.observedAt.toISOString())
        .join(),
    );

    const jaSold = await listTcgSoldHistory(db, { printingId: ja });
    const zhSold = await listTcgSoldHistory(db, { printingId: zh });
    expect(jaSold).toHaveLength(1);
    expect(zhSold).toHaveLength(1);
    expect(jaSold[0]?.currency).toBe("JPY");
    expect(zhSold[0]?.currency).toBe("CNY");
    expect(jaSold[0]?.printingId).not.toBe(enSold[0]?.printingId);
    expect(zhSold[0]?.printingId).not.toBe(enSold[0]?.printingId);

    const holoSold = await listTcgSoldHistory(db, { printingId: holo });
    expect(holoSold).toHaveLength(1);
    expect(holoSold[0]?.printingId).not.toBe(en);

    const lp = await listTcgSoldHistory(db, { printingId: en, condition: "lp" });
    expect(lp).toHaveLength(1);
    expect(Number(lp[0]?.price)).toBe(28);

    const psa = await listTcgSoldHistory(db, {
      printingId: en,
      gradingCompany: "psa",
      gradeLabel: "10",
    });
    expect(psa).toHaveLength(1);
    expect(Number(psa[0]?.price)).toBe(250);
    expect(enSold.filter((row) => row.gradingCompany == null).every((row) => Number(row.price) !== 250)).toBe(true);

    const listing = await listTcgListingHistory(db, { printingId: en, sourceKey: "tcgplayer" });
    expect(listing).toHaveLength(1);
    expect(listing[0]?.listingCount).toBe(12);
    expect(Number(listing[0]?.lowPrice)).toBe(39);
    expect(listing[0]?.aggregationKind).toBe("window");

    const reference = await getLatestTcgMarketSnapshot(db, {
      printingId: en,
      sourceKey: "fixture",
      priceType: "reference",
    });
    expect(Number(reference?.price)).toBe(43);

    const latestTcc = await getLatestTcgMarketSnapshot(db, {
      printingId: en,
      sourceKey: "tcg_card_central",
      priceType: "sold",
      condition: "nm",
      gradingCompany: null,
    });
    expect(Number(latestTcc?.price)).toBe(4000);
    expect(latestTcc?.outlierFlag).toBe(true);
    expect(latestTcc?.outlierReason).toBe("outside_rolling_median");
    expect(latestTcc?.qualityLabel).toBe("outlier");
    expect(latestTcc?.outlierAlgorithmVersion).toBe("outlier.v1");

    const spread = await getTcgAskSoldSpread(db, { printingId: en, condition: "nm", currency: "USD" });
    expect(spread.formula).toBe("lowest_ask_minus_latest_sold");
    expect(spread.spread_abs).toBe(39 - 4000);
    expect(spread.version).toBe("spread.v1");

    const window = listWindow("7d", new Date("2026-01-06T00:00:00.000Z"));
    const ranged = await listTcgSoldHistory(db, { printingId: en, from: window.from, to: window.to });
    expect(ranged.length).toBeGreaterThan(0);

    const returns = computeDailyReturns(
      enSold
        .filter((row) => row.price != null && row.gradingCompany == null)
        .map((row) => ({ observedAt: row.observedAt, price: Number(row.price) })),
    );
    expect(returns.every((row) => row.day.includes("-"))).toBe(true);

    const liquidity = summarizeTcgLiquidityInputs(
      listing.map((row) => ({
        observedAt: row.observedAt,
        salesCount: row.salesCount,
        listingCount: row.listingCount,
        sellerCount: row.sellerCount,
        bidCount: row.bidCount,
      })),
    );
    expect(liquidity.listing_count).toBe(12);
    expect(liquidity.seller_count).toBe(8);

    await expect(
      ingestTcgMarketRecord(db, sold({ provider_record_id: "sold_en_nm_1", provider: "tcg_card_central", price: 99 })),
    ).rejects.toBeInstanceOf(TcgMarketRevisionError);

    await expect(ingestTcgMarketRecord(db, sold({ currency: "usd", provider_record_id: "bad_ccy" }))).rejects.toBeInstanceOf(
      TcgMarketValidationError,
    );
    await expect(ingestTcgMarketRecord(db, sold({ price: -5, provider_record_id: "bad_price" }))).rejects.toBeInstanceOf(
      TcgMarketValidationError,
    );

    const missing = await ingestTcgMarketRecord(
      db,
      sold({ provider_record_id: "missing_prn", printing: { game: "pokemon", set: "twm", collector_number: "000/000", language: "en", variant: "normal" } }),
    );
    expect(missing.status).toBe("quarantined");

    const ambiguous = await ingestTcgMarketRecord(
      db,
      sold({
        provider_record_id: "ambiguous_prn",
        printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en" },
      }),
    );
    expect(ambiguous.status).toBe("quarantined");
    expect((await listTcgMarketQuarantine(db)).some((row) => row.reason === "ambiguous")).toBe(true);

    const conceptOnly = await ingestTcgMarketRecord(
      db,
      sold({
        provider_record_id: "concept_only",
        printing: { game: "pokemon" },
      }),
    );
    expect(conceptOnly.status).toBe("quarantined");
    expect((await listTcgMarketQuarantine(db)).some((row) => row.reason === "concept_only")).toBe(true);

    const snapshot = await getLatestTcgMarketSnapshot(db, { printingId: en, sourceKey: "fixture", priceType: "reference" });
    const projected = await withOrganizationContext(db, { organizationId: "org_mkt", userId: "user_mkt" }, (scoped) =>
      projectTcgMarketSnapshotToTenant(scoped, { organizationId: "org_mkt", snapshot: snapshot! }),
    );
    expect(projected.entity.entityType).toBe("tcg_printing");
    const replayProject = await withOrganizationContext(db, { organizationId: "org_mkt", userId: "user_mkt" }, (scoped) =>
      projectTcgMarketSnapshotToTenant(scoped, { organizationId: "org_mkt", snapshot: snapshot! }),
    );
    expect(replayProject.observation?.id).toBe(projected.observation?.id);
    const metrics = await withOrganizationContext(db, { organizationId: "org_mkt", userId: "user_mkt" }, (scoped) =>
      listObservationMetrics(scoped, { organizationId: "org_mkt", observationId: projected.observation!.id }),
    );
    expect(metrics.some((row) => row.metricKey === "market.price.reference")).toBe(true);
    expect(metrics[0]?.dimension).toMatchObject({ source: "fixture", currency: "USD", condition: "nm" });

    const received = await receiveTcgMarketRecord(db, sold({ provider_record_id: "worker_replay_1", price: 37 }));
    const first = await normalizeTcgMarketIngest(db, received.ingestId);
    const second = await normalizeTcgMarketIngest(db, received.ingestId);
    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
  });

  it("uses in-memory fixture providers only", async () => {
    const records = tcgMarketFixtureRecords();
    const tcc = fixtureTcgCardCentralMarketProvider(records);
    const tcgplayer = fixtureTcgplayerMarketProvider(records);
    const ebay = fixtureEbayMarketProvider(records);
    expect(await tcc.healthCheck()).toEqual({ ok: true, mode: "sandbox_fixture" });
    expect((await tcc.getSoldTransactions({ language: "en" })).every((row) => row.provider === "tcg_card_central")).toBe(
      true,
    );
    expect((await tcgplayer.getListingSnapshot({ language: "en" }))?.provider).toBe("tcgplayer");
    expect((await ebay.getMarketSnapshots({})).some((row) => row.event_type === "tcg.market.volume_snapshot")).toBe(
      true,
    );
    const src = readFileSync(path.join(here, "market-provider.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/https?:\/\/(api\.)?tcgplayer\.com/i);
    expect(src).not.toMatch(/https?:\/\/.*ebay\.com/i);
    expect(src).not.toMatch(/https?:\/\/tcgcardcentral\.com/i);
  });
});
