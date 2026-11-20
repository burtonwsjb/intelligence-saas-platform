import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ingestTcgMarketRecord, readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import { TCGCSV_USER_AGENT, gameForCategory, pickTcgcsvRow } from "./tcgcsv-common.js";
import { syncTcgcsvDaily } from "./tcgcsv-daily.js";
import type { HttpTransport } from "./transport.js";

const ENABLED = { TCGCSV_DAILY_ENABLED: "1" };
const EVENING = new Date("2026-11-20T22:00:00Z");

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const fx = await seedTcgIdentityFixtures(db);
  const printingId = fx.printings.greninjaEnNormal.id;
  // An earlier TCC answer told us the printing's TCGplayer product, set name and sub-type (no group id yet).
  await client.query(
    `INSERT INTO tcg_tcgplayer_link (printing_id, group_name, product_id, sub_type, method) VALUES ($1, 'SV06: Twilight Masquerade', 555, 'Normal', 'tcc_answer')`,
    [printingId],
  );
  return { client, db, printingId };
}

function fakeTcgcsv(options: { refuse?: boolean; build?: string } = {}) {
  const urls: string[] = [];
  const agents: string[] = [];
  const transport: HttpTransport = {
    async fetch(url, init) {
      urls.push(url);
      agents.push(init?.headers?.["user-agent"] ?? "");
      if (options.refuse) return { status: 403, headers: {}, bodyText: "" };
      if (url === "https://tcgcsv.com/last-updated.txt")
        return { status: 200, headers: {}, bodyText: `${options.build ?? "2026-11-20T20:05:33+0000"}\n` };
      const path = new URL(url).pathname;
      let results: unknown[] = [];
      if (path === "/tcgplayer/categories")
        results = [
          { categoryId: 21, name: "Pokemon" }, // a skipped category is never used, even if named the same
          { categoryId: 3, name: "Pokemon" },
          { categoryId: 85, name: "Pokemon Japan" },
          { categoryId: 68, name: "One Piece Card Game" },
        ];
      else if (path === "/tcgplayer/3/groups")
        results = [
          { groupId: 23473, name: "SV06: Twilight Masquerade", abbreviation: "TWM", modifiedOn: "2026-11-01T00:00:00" },
          { groupId: 1, name: "Base Set", abbreviation: "BS" },
        ];
      else if (path === "/tcgplayer/3/23473/prices")
        results = [
          { productId: 555, subTypeName: "Reverse Holofoil", marketPrice: 99 },
          { productId: 555, subTypeName: "Normal", marketPrice: 42.5, lowPrice: 38, midPrice: 41, highPrice: 60 },
          { productId: 556, subTypeName: "Normal", marketPrice: 1 },
        ];
      else throw new Error(`unexpected ${url}`);
      return { status: 200, headers: {}, bodyText: JSON.stringify({ success: true, results }) };
    },
  };
  return { transport, urls, agents };
}

describe("tcgcsv daily prices", () => {
  it("picks only the printing's own product and sub-type", () => {
    const rows = [
      { productId: 1, subTypeName: "Holofoil", marketPrice: 5 },
      { productId: 1, subTypeName: "Normal", marketPrice: null },
    ];
    expect(pickTcgcsvRow(rows, { productId: 1, subType: "Holofoil" })).toMatchObject({ market: 5 });
    expect(pickTcgcsvRow(rows, { productId: 1, subType: "Normal" })).toBeNull();
    expect(pickTcgcsvRow(rows, { productId: 2, subType: "Holofoil" })).toBeNull();
  });

  it("maps tcgcsv categories to games, never skipped or other-language ones", () => {
    expect(gameForCategory({ categoryId: 3, name: "Pokemon" })).toBe("pokemon");
    expect(gameForCategory({ categoryId: 21, name: "Pokemon" })).toBeNull();
    expect(gameForCategory({ categoryId: 85, name: "Pokemon Japan" })).toBeNull();
    expect(gameForCategory({ categoryId: 68, name: "One Piece Card Game" })).toBe("one_piece");
    expect(gameForCategory({ categoryId: 2, name: "YuGiOh" })).toBe("yugioh");
    expect(gameForCategory({ categoryId: 1, name: "Magic" })).toBe("magic");
    expect(gameForCategory({ categoryId: 71, name: "Lorcana TCG" })).toBe("lorcana");
    expect(gameForCategory({ categoryId: 27, name: "Dragon Ball Super CCG" })).toBe("dragon_ball");
  });

  it("migration keeps TCG Card Central's latest product match for each printing", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await seedTcgIdentityFixtures(db);
    const printing = { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" };
    for (const [day, product] of [["2026-11-01", 554], ["2026-11-09", 555]] as const) {
      await ingestTcgMarketRecord(db, {
        provider: "tcg_card_central",
        provider_record_id: `tcc:history:x:${day}`,
        event_type: "tcg.market.reference_price",
        market_type: "market_price",
        price_type: "reference",
        observed_at: `${day}T23:59:59.000Z`,
        currency: "USD",
        condition: "unknown",
        raw_condition: "product_level",
        price: 40,
        printing,
        attributes: { tcgplayer_product_id: product, tcgplayer_group_name: "SV06: Twilight Masquerade", tcgplayer_sub_type: "Normal" },
      });
    }
    const migration = await readFile(new URL("../../drizzle/0043_tcg_daily_price.sql", import.meta.url), "utf8");
    await client.exec(migration);
    const links = (await client.query<{ product_id: number; group_name: string; method: string }>("SELECT product_id, group_name, method FROM tcg_tcgplayer_link")).rows;
    expect(links).toEqual([{ product_id: 555, group_name: "SV06: Twilight Masquerade", method: "tcc_answer" }]);
  });

  it("is off unless enabled, and waits for the evening update", async () => {
    const { db } = await setup();
    const { transport, urls } = fakeTcgcsv();
    expect(await syncTcgcsvDaily(db, { env: {}, transport, now: EVENING })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(await syncTcgcsvDaily(db, { env: ENABLED, transport, now: new Date("2026-11-20T15:00:00Z") })).toMatchObject({
      status: "skipped",
      reason: "before_start_hour",
    });
    expect(urls).toHaveLength(0);
  });

  it("prices linked printings once per build from one file per set, with a clear name and spacing", async () => {
    const { client, db, printingId } = await setup();
    const { transport, urls, agents } = fakeTcgcsv();
    const waits: number[] = [];
    const report = await syncTcgcsvDaily(db, { env: ENABLED, transport, now: EVENING, sleep: async (ms) => void waits.push(ms) });
    expect(report).toMatchObject({ status: "completed", groups: 1, linked: 1, priced: 1, written: 1, linksResolved: 1, requests: 4 });
    expect(urls).toEqual([
      "https://tcgcsv.com/last-updated.txt",
      "https://tcgcsv.com/tcgplayer/categories",
      "https://tcgcsv.com/tcgplayer/3/groups",
      "https://tcgcsv.com/tcgplayer/3/23473/prices",
    ]);
    expect(new Set(agents)).toEqual(new Set([TCGCSV_USER_AGENT]));
    expect(waits).toEqual([250, 250, 250]);
    const link = (await client.query<{ group_id: number; category_id: number }>("SELECT group_id, category_id FROM tcg_tcgplayer_link")).rows[0]!;
    expect(link).toMatchObject({ group_id: 23473, category_id: 3 });
    // Slim row, read through the combined view like every price reader does.
    const rows = (
      await client.query<{ source_key: string; price: string; observed_at: Date; source_record_id: string; printing_id: string }>(
        "SELECT source_key, price, observed_at, source_record_id, printing_id FROM tcg_market_price_all WHERE source_key = 'tcgplayer'",
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.price)).toBe(42.5);
    expect(rows[0]!.printing_id).toBe(printingId);
    expect(new Date(rows[0]!.observed_at).toISOString()).toBe("2026-11-20T20:00:00.000Z");
    expect(rows[0]!.source_record_id).toBe(`tcgcsv:daily:${printingId}:2026-11-20`);
    expect((await client.query("SELECT 1 FROM tcg_market_snapshot WHERE source_key = 'tcgplayer'")).rows).toHaveLength(0);

    // Same build again: only last-updated.txt is read.
    const again = await syncTcgcsvDaily(db, { env: ENABLED, transport, now: new Date("2026-11-20T23:00:00Z"), sleep: async () => {} });
    expect(again).toMatchObject({ status: "skipped", reason: "no_new_build" });
    expect(urls.slice(4)).toEqual(["https://tcgcsv.com/last-updated.txt"]);

    // A new build: catalog once more, then the set's price file.
    const fresh = fakeTcgcsv({ build: "2026-11-21T20:04:00+0000" });
    const next = await syncTcgcsvDaily(db, { env: ENABLED, transport: fresh.transport, now: new Date("2026-11-21T22:00:00Z"), sleep: async () => {} });
    expect(next).toMatchObject({ status: "completed", written: 1, groups: 1 });
    expect((await client.query("SELECT 1 FROM tcg_daily_price")).rows).toHaveLength(2);
  });

  it("stops at the first refusal and stays away for a week", async () => {
    const { db } = await setup();
    const refused = fakeTcgcsv({ refuse: true });
    const report = await syncTcgcsvDaily(db, { env: ENABLED, transport: refused.transport, now: EVENING, sleep: async () => {} });
    expect(report).toMatchObject({ status: "stopped", reason: "refused_403", requests: 1, written: 0 });
    expect(refused.urls).toEqual(["https://tcgcsv.com/last-updated.txt"]);
    const ok = fakeTcgcsv();
    const nextDay = await syncTcgcsvDaily(db, { env: ENABLED, transport: ok.transport, now: new Date("2026-11-22T22:00:00Z") });
    expect(nextDay).toMatchObject({ status: "skipped", reason: "refused_recently" });
    expect(ok.urls).toHaveLength(0);
  });
});
