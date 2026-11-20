import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ingestTcgMarketRecord, readMigrationSql, seedTcgIdentityFixtures, type Database } from "../index.js";
import {
  TCGCSV_USER_AGENT,
  collectTcgcsvDaily,
  pickTcgcsvRow,
  syncTcgcsvDaily,
  tcgcsvDailyRecordId,
  type TcgcsvTarget,
} from "./tcgcsv-daily.js";
import type { HttpTransport } from "./transport.js";

const ENABLED = { TCGCSV_DAILY_ENABLED: "1" };
const EVENING = new Date("2026-11-20T22:00:00Z");

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await seedTcgIdentityFixtures(db);
  // An earlier TCC answer told us the printing's TCGplayer product, set and sub-type.
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
    printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
    attributes: { tcgplayer_product_id: 555, tcgplayer_group_name: "SV06: Twilight Masquerade", tcgplayer_sub_type: "Normal" },
  });
  return { client, db };
}

function fakeTcgcsv(options: { refuse?: boolean } = {}) {
  const urls: string[] = [];
  const agents: string[] = [];
  const transport: HttpTransport = {
    async fetch(url, init) {
      urls.push(url);
      agents.push(init?.headers?.["user-agent"] ?? "");
      if (options.refuse) return { status: 403, headers: {}, bodyText: "" };
      const path = new URL(url).pathname;
      let results: unknown[] = [];
      if (path === "/tcgplayer/categories")
        results = [
          { categoryId: 21, name: "Pokemon" }, // a skipped category is never used, even if named the same
          { categoryId: 3, name: "Pokemon" },
          { categoryId: 85, name: "Pokemon Japan" },
          { categoryId: 68, name: "One Piece Card Game" },
        ];
      else if (path === "/tcgplayer/3/groups") results = [{ groupId: 23473, name: "SV06: Twilight Masquerade" }];
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

  it("is off unless enabled, and waits for the evening update", async () => {
    const { db } = await setup();
    const { transport, urls } = fakeTcgcsv();
    expect(await syncTcgcsvDaily(db, { env: {}, transport, now: EVENING })).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(
      await syncTcgcsvDaily(db, { env: ENABLED, transport, now: new Date("2026-11-20T15:00:00Z") }),
    ).toMatchObject({ status: "skipped", reason: "before_start_hour" });
    expect(urls).toHaveLength(0);
  });

  it("prices known printings once a day from one file per set, with a clear name and spacing", async () => {
    const { client, db } = await setup();
    const { transport, urls, agents } = fakeTcgcsv();
    const waits: number[] = [];
    const report = await syncTcgcsvDaily(db, { env: ENABLED, transport, now: EVENING, sleep: async (ms) => void waits.push(ms) });
    expect(report).toMatchObject({ status: "completed", targets: 1, groups: 1, requests: 3, priced: 1, written: 1 });
    expect(urls).toEqual([
      "https://tcgcsv.com/tcgplayer/categories",
      "https://tcgcsv.com/tcgplayer/3/groups",
      "https://tcgcsv.com/tcgplayer/3/23473/prices",
    ]);
    expect(new Set(agents)).toEqual(new Set([TCGCSV_USER_AGENT]));
    expect(waits).toEqual([1000, 1000]);
    const rows = (
      await client.query<{ source_key: string; price: string; source_record_id: string }>(
        "SELECT source_key, price, source_record_id FROM tcg_market_snapshot WHERE source_key = 'tcgplayer'",
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.price)).toBe(42.5);
    expect(rows[0]!.source_record_id).toMatch(/^tcgcsv:daily:.+:2026-11-20$/);

    // Same day again: nothing is asked.
    const again = await syncTcgcsvDaily(db, { env: ENABLED, transport, now: new Date("2026-11-20T23:00:00Z"), sleep: async () => {} });
    expect(again).toMatchObject({ status: "skipped", reason: "done_today" });
    expect(urls).toHaveLength(3);
  });

  it("stops at the first refusal and stays away for a week", async () => {
    const { db } = await setup();
    const refused = fakeTcgcsv({ refuse: true });
    const report = await syncTcgcsvDaily(db, { env: ENABLED, transport: refused.transport, now: EVENING, sleep: async () => {} });
    expect(report).toMatchObject({ status: "stopped", reason: "refused_403", requests: 1, written: 0 });
    const ok = fakeTcgcsv();
    const nextDay = await syncTcgcsvDaily(db, { env: ENABLED, transport: ok.transport, now: new Date("2026-11-22T22:00:00Z") });
    expect(nextDay).toMatchObject({ status: "skipped", reason: "refused_recently" });
    expect(ok.urls).toHaveLength(0);
  });

  it("never passes the request cap", async () => {
    const { transport, urls } = fakeTcgcsv();
    const target: TcgcsvTarget = {
      printingId: "p1",
      game: "pokemon",
      setKey: "twm",
      collectorNumber: "214/167",
      language: "en",
      variant: "normal",
      productId: 555,
      groupName: "SV06: Twilight Masquerade",
      subType: "Normal",
    };
    const { report, records } = await collectTcgcsvDaily({ targets: [target], transport, now: EVENING, maxRequests: 2, sleep: async () => {} });
    expect(report).toMatchObject({ status: "stopped", reason: "request_cap", requests: 2 });
    expect(records).toHaveLength(0);
    expect(urls).toHaveLength(2);
    expect(tcgcsvDailyRecordId("p1", "2026-11-20")).toBe("tcgcsv:daily:p1:2026-11-20");
  });
});
