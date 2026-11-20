import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ingestTcgMarketRecord, readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import { indexArchiveDir, plannedArchiveDays, syncTcgcsvHistory, type TcgcsvArchiveReader } from "./tcgcsv-history.js";

const ENABLED = { TCGCSV_HISTORY_ENABLED: "1", TCGCSV_HISTORY_FROM: "2026-11-08", TCGCSV_HISTORY_DAYS_PER_RUN: "6" };
const NOW = new Date("2026-11-12T10:00:00Z");
const PRINTING = { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" };

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  // TCC history up to Nov 9: tells us the product and sub-type, and covers Nov 9 already.
  await ingestTcgMarketRecord(db, {
    provider: "tcg_card_central",
    provider_record_id: "tcc:history:x:2026-11-09",
    event_type: "tcg.market.reference_price",
    market_type: "market_price",
    price_type: "reference",
    observed_at: "2026-11-09T23:59:59.000Z",
    currency: "USD",
    condition: "unknown",
    raw_condition: "product_level",
    price: 40,
    printing: PRINTING,
    attributes: { tcgplayer_product_id: 555, tcgplayer_group_name: "SV06: Twilight Masquerade", tcgplayer_sub_type: "Normal" },
  });
  await client.query(
    `INSERT INTO tcg_tcgplayer_link (printing_id, category_id, group_id, group_name, product_id, sub_type, method)
     SELECT printing_id, 3, 23473, 'SV06: Twilight Masquerade', 555, 'Normal', 'tcc_answer' FROM tcg_market_snapshot LIMIT 1`,
  );
  return { client, db };
}

function fakeArchive(options: { refuseOn?: string; missing?: string[] } = {}) {
  const asked: string[] = [];
  const read: TcgcsvArchiveReader = async (day, categories) => {
    asked.push(day);
    expect(categories).toEqual([3]);
    if (day === options.refuseOn) return { status: "refused", reason: "refused_403", downloaded: false };
    if (options.missing?.includes(day)) return { status: "missing", reason: "no_archive", downloaded: false };
    const price = 40 + Number(day.slice(-2));
    return { status: "ok", byProduct: new Map([[555, [{ productId: 555, subTypeName: "Normal", marketPrice: price }]]]) };
  };
  return { read, asked };
}

describe("tcgcsv price archive", () => {
  it("plans newest days first, before today, back to the start day, skipping done days", () => {
    expect(plannedArchiveDays({ now: NOW, from: "2026-11-08", done: new Set(["2026-11-10"]), limit: 10 })).toEqual([
      "2026-11-11",
      "2026-11-09",
      "2026-11-08",
    ]);
    expect(plannedArchiveDays({ now: NOW, from: "2026-11-08", done: new Set(), limit: 2 })).toEqual(["2026-11-11", "2026-11-10"]);
  });

  it("indexes only the asked categories' price files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcgcsv-test-"));
    try {
      await mkdir(join(root, "2026-11-10", "3", "23473"), { recursive: true });
      await mkdir(join(root, "2026-11-10", "1", "1"), { recursive: true });
      await writeFile(join(root, "2026-11-10", "3", "23473", "prices"), JSON.stringify({ results: [{ productId: 555, subTypeName: "Normal", marketPrice: 9 }] }));
      await writeFile(join(root, "2026-11-10", "1", "1", "prices"), JSON.stringify({ results: [{ productId: 777, subTypeName: "Normal", marketPrice: 1 }] }));
      const index = await indexArchiveDir(root, "2026-11-10", [3]);
      expect([...index.keys()]).toEqual([555]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is off unless enabled", async () => {
    const { db } = await setup();
    const archive = fakeArchive();
    expect(await syncTcgcsvHistory(db, { env: {}, now: NOW, readArchive: archive.read })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(archive.asked).toEqual([]);
  });

  it("fills missing days once each, never doubling a day that already has a price", async () => {
    const { client, db } = await setup();
    const archive = fakeArchive({ missing: ["2026-11-08"] });
    const report = await syncTcgcsvHistory(db, { env: ENABLED, now: NOW, readArchive: archive.read, sleep: async () => {} });
    expect(archive.asked).toEqual(["2026-11-11", "2026-11-10", "2026-11-09", "2026-11-08"]);
    expect(report.written).toBe(2);
    expect(report.days.find((d) => d.day === "2026-11-09")).toMatchObject({ skipped: 1, written: 0 });
    const rows = (
      await client.query<{ source_record_id: string; price: string; attributes: { price_source: string } }>(
        "SELECT source_record_id, price, attributes FROM tcg_market_price_all WHERE source_key = 'tcgplayer' ORDER BY observed_at",
      )
    ).rows;
    expect(rows.every((r) => r.attributes.price_source === "tcgcsv_archive")).toBe(true);
    expect(rows.map((r) => [r.source_record_id.slice(-10), Number(r.price)])).toEqual([
      ["2026-11-10", 50],
      ["2026-11-11", 51],
    ]);

    // Every day was asked once; a later run downloads nothing again.
    const again = await syncTcgcsvHistory(db, { env: ENABLED, now: NOW, readArchive: archive.read, sleep: async () => {} });
    expect(again).toMatchObject({ status: "skipped", reason: "nothing_due" });
    expect(archive.asked).toHaveLength(4);
  });

  it("stops at a refusal and stays away for a week", async () => {
    const { db } = await setup();
    const archive = fakeArchive({ refuseOn: "2026-11-10" });
    const report = await syncTcgcsvHistory(db, { env: ENABLED, now: NOW, readArchive: archive.read, sleep: async () => {} });
    expect(report).toMatchObject({ status: "stopped", reason: "refused_403" });
    expect(archive.asked).toEqual(["2026-11-11", "2026-11-10"]);
    const later = await syncTcgcsvHistory(db, { env: ENABLED, now: new Date("2026-11-15T10:00:00Z"), readArchive: archive.read });
    expect(later).toMatchObject({ status: "skipped", reason: "refused_recently" });
    expect(archive.asked).toHaveLength(2);
  });
});
