import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import { matchGroup, normNumber, subTypeFor, syncTcgcsvMatch } from "./tcgcsv-match.js";
import type { HttpTransport } from "./transport.js";

const ENABLED = { TCGCSV_MATCH_ENABLED: "1" };
const NOW = new Date("2026-11-20T22:00:00Z");

const num = (n: string) => [{ name: "Number", value: n }];

function fakeTcgcsv() {
  const urls: string[] = [];
  const transport: HttpTransport = {
    async fetch(url) {
      urls.push(url);
      if (url === "https://tcgcsv.com/last-updated.txt") return { status: 200, headers: {}, bodyText: "2026-11-20T20:05:33+0000" };
      const path = new URL(url).pathname;
      let results: unknown[];
      if (path === "/tcgplayer/categories")
        results = [
          { categoryId: 3, name: "Pokemon" },
          { categoryId: 68, name: "One Piece Card Game" },
        ];
      else if (path === "/tcgplayer/3/groups")
        results = [{ groupId: 23473, name: "SV06: Twilight Masquerade", abbreviation: "TWM", modifiedOn: "2026-11-01T00:00:00" }];
      else if (path === "/tcgplayer/68/groups") results = [{ groupId: 3188, name: "Romance Dawn", abbreviation: "OP01", modifiedOn: "2026-10-01T00:00:00" }];
      else if (path === "/tcgplayer/3/23473/products")
        results = [
          { productId: 555, name: "Greninja ex - 214/167", extendedData: num("214/167") },
          { productId: 600, name: "Some Other Card", extendedData: num("001/167") },
        ];
      else if (path === "/tcgplayer/3/23473/prices")
        results = [
          { productId: 555, subTypeName: "Normal", marketPrice: 42.5 },
          { productId: 555, subTypeName: "Holofoil", marketPrice: 50 },
          { productId: 555, subTypeName: "Reverse Holofoil", marketPrice: 60 },
          { productId: 600, subTypeName: "Normal", marketPrice: 1 },
        ];
      else if (path === "/tcgplayer/68/3188/products")
        results = [
          { productId: 7001, name: "Monkey.D.Luffy", extendedData: num("OP01-001") },
          { productId: 7002, name: "Monkey.D.Luffy (Parallel)", extendedData: num("OP01-001") },
        ];
      else if (path === "/tcgplayer/68/3188/prices")
        results = [
          { productId: 7001, subTypeName: "Normal", marketPrice: 3 },
          { productId: 7002, subTypeName: "Normal", marketPrice: 30 },
        ];
      else throw new Error(`unexpected ${url}`);
      return { status: 200, headers: {}, bodyText: JSON.stringify({ success: true, results }) };
    },
  };
  return { transport, urls };
}

describe("tcgcsv card-list matching", () => {
  it("compares numbers without leading zeros or the set size", () => {
    expect(normNumber("025/198")).toBe("25");
    expect(normNumber("TG05/TG30")).toBe("tg5");
    expect(normNumber("OP01-001")).toBe("op1-1");
    expect(normNumber("LOB-EN001")).toBe("lob-en1");
  });

  it("picks the sub-type that fits the variant", () => {
    expect(subTypeFor("normal", ["Holofoil", "Normal"])).toBe("Normal");
    expect(subTypeFor("holofoil", ["Normal", "Holofoil"])).toBe("Holofoil");
    expect(subTypeFor("reverse_holo", ["Normal", "Holofoil"])).toBeNull();
    expect(subTypeFor("normal", ["1st Edition"])).toBe("1st Edition");
    expect(subTypeFor("parallel", ["Foil"])).toBe("Foil");
  });

  it("links only when exactly one product fits, keeping parallels apart", () => {
    const products = [
      { productId: 1, name: "Monkey.D.Luffy", extendedData: num("OP01-001") },
      { productId: 2, name: "Monkey.D.Luffy (Parallel)", extendedData: num("OP01-001") },
      { productId: 3, name: "Nami", extendedData: num("OP01-016") },
      { productId: 4, name: "Nami (Alternate Art)", extendedData: num("OP01-016") },
      { productId: 5, name: "Nami (Alternate Art) [Promo]", extendedData: num("OP01-016") },
    ];
    const prices = [1, 2, 3, 4, 5].map((productId) => ({ productId, subTypeName: "Normal", marketPrice: 1 }));
    const { links, ambiguous } = matchGroup(
      [
        { printingId: "a", collectorNumber: "OP01-001", variant: "normal", name: "Monkey D. Luffy" },
        { printingId: "b", collectorNumber: "OP01-001", variant: "parallel", name: "Monkey D. Luffy" },
        { printingId: "c", collectorNumber: "OP01-016", variant: "normal", name: "Nami" },
        { printingId: "d", collectorNumber: "OP01-016", variant: "parallel", name: "Nami" },
        { printingId: "e", collectorNumber: "OP01-099", variant: "normal", name: "Nobody" },
      ],
      products,
      prices,
    );
    expect(links).toEqual([
      { printingId: "a", productId: 1, subType: "Normal" },
      { printingId: "b", productId: 2, subType: "Normal" },
      { printingId: "c", productId: 3, subType: "Normal" },
    ]);
    expect(ambiguous).toBe(1);
  });

  it("is off unless enabled", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const { transport, urls } = fakeTcgcsv();
    expect(await syncTcgcsvMatch(db, { env: {}, transport, now: NOW })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(urls).toHaveLength(0);
  });

  it("links English printings set by set in game order, prices them from the same file, and reads each set once", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const fx = await seedTcgIdentityFixtures(db);
    const { transport, urls } = fakeTcgcsv();
    const report = await syncTcgcsvMatch(db, { env: ENABLED, transport, now: NOW, sleep: async () => {} });
    expect(report).toMatchObject({ status: "completed", groups: 2, linked: 4, byGame: { pokemon: 3, one_piece: 1 } });
    expect(urls.slice(4)).toEqual([
      "https://tcgcsv.com/tcgplayer/3/23473/products",
      "https://tcgcsv.com/tcgplayer/3/23473/prices",
      "https://tcgcsv.com/tcgplayer/68/3188/products",
      "https://tcgcsv.com/tcgplayer/68/3188/prices",
    ]);
    const links = (
      await client.query<{ printing_id: string; product_id: number; sub_type: string }>(
        "SELECT printing_id, product_id, sub_type FROM tcg_tcgplayer_link ORDER BY product_id, sub_type",
      )
    ).rows;
    const p = fx.printings;
    expect(links).toEqual(
      expect.arrayContaining([
        { printing_id: p.greninjaEnNormal.id, product_id: 555, sub_type: "Normal" },
        { printing_id: p.greninjaEnHolo.id, product_id: 555, sub_type: "Holofoil" },
        { printing_id: p.greninjaEnReverse.id, product_id: 555, sub_type: "Reverse Holofoil" },
        { printing_id: p.luffyEn.id, product_id: 7001, sub_type: "Normal" },
      ]),
    );
    expect(links.some((l) => l.printing_id === p.greninjaJaNormal.id)).toBe(false);
    // Today's prices came from the files already read; the daily step will not ask for them again.
    expect((await client.query("SELECT 1 FROM tcg_daily_price")).rows).toHaveLength(4);
    expect((await client.query("SELECT 1 FROM tcg_tcgplayer_group WHERE prices_build IS NULL")).rows).toHaveLength(0);

    // Next run: nothing changed, so only last-updated.txt is read.
    const again = await syncTcgcsvMatch(db, { env: ENABLED, transport, now: new Date("2026-11-20T23:00:00Z"), sleep: async () => {} });
    expect(again).toMatchObject({ status: "completed", groups: 0, linked: 0 });
    expect(urls.slice(8)).toEqual(["https://tcgcsv.com/last-updated.txt"]);
  });
});
