import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { seedTcgIdentityFixtures } from "../tcg/fixtures.js";
import { insertTcgCardConcept, insertTcgPrinting, insertTcgSet } from "../tcg/catalog.js";
import { syncSealedProducts } from "../tcg/sealed.js";
import { setAliasCandidates, syncSetAssets } from "../tcg/set-assets.js";
import { extractAssetCallsFromContent, findAssetForTopic } from "./assets.js";
import { rescanAssetCalls } from "./asset-call-rescan.js";
import { scoreDueCreatorCalls } from "./due.js";
import { getCreatorAuthorityProfile } from "./authority.js";
import { FLAT_BAND, setBasketMove } from "./outcomes.js";
import { getTopicCalls } from "../topics/topics.js";
import { ensureProviderRuntimeRows } from "../providers/runtime.js";

describe("set names as call aliases", () => {
  it("keeps the catalog name and the name without a code prefix, never a common word", () => {
    expect(setAliasCandidates("SV: Prismatic Evolutions")).toEqual(["sv: prismatic evolutions", "prismatic evolutions"]);
    expect(setAliasCandidates("Ascended Heroes")).toEqual(["ascended heroes"]);
    expect(setAliasCandidates("E")).toEqual([]);
    expect(setAliasCandidates("151")).toEqual([]);
    expect(setAliasCandidates("Base")).toEqual([]);
  });
});

describe("calls about a whole set", () => {
  let client: PGlite;
  let db: Database;
  let setId: string;
  const printings: string[] = [];

  /** Daily raw market prices for one printing from `start`, one per day. */
  async function prices(printingId: string, start: string, values: number[]) {
    for (const [day, value] of values.entries()) {
      const id = `r_${printingId}_${start}_${day}`;
      await client.query(
        `INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price, source_record_id, fingerprint)
         VALUES ($1, $2, 'tcg_card_central', 'market_price', 'reference', timestamptz '${start}' + $3 * interval '1 day', 'USD', 'nm', $4, $1, $1)`,
        [id, printingId, day, value],
      );
    }
  }

  async function post(id: string, account: string, at: string, title: string) {
    await client.query(
      `INSERT INTO source_content (id, source_type, external_content_id, account_id, published_at, title, canonical_url, content_type, fingerprint)
       VALUES ($1, 'youtube', $1, $2, $3, $4, 'https://example.test/' || $1, 'video', $1)`,
      [id, account, at, title],
    );
  }

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await seedTcgIdentityFixtures(db);
    await ensureProviderRuntimeRows(db, {});
    const set = await insertTcgSet(db, { gameKey: "pokemon", canonicalSetKey: "asc", name: "Ascended Heroes", languageScope: "en" });
    setId = set.id;
    // Two sets share a name: neither may claim it.
    await insertTcgSet(db, { gameKey: "pokemon", canonicalSetKey: "dup1", name: "Shared Name Set", languageScope: "en" });
    await insertTcgSet(db, { gameKey: "pokemon", canonicalSetKey: "dup2", name: "Shared Name Set", languageScope: "ja" });
    for (const [index, name] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
      const card = await insertTcgCardConcept(db, { gameKey: "pokemon", conceptKey: `asc-${name.toLowerCase()}`, canonicalName: `${name} ex` });
      const row = await insertTcgPrinting(db, {
        cardId: card.id,
        setId,
        gameKey: "pokemon",
        conceptKey: card.conceptKey,
        setKey: "asc",
        collectorNumber: `${index + 1}/100`,
        language: "en",
        variantKey: "normal",
      });
      printings.push(row.id);
    }
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at) VALUES
        ('sa_right', 'youtube', 'UCright', 'Right Caller', now(), now()),
        ('sa_flat', 'youtube', 'UCflat', 'Flat Caller', now(), now()),
        ('sa_box', 'youtube', 'UCbox', 'Box Caller', now(), now());
    `);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  it("creates one set asset per set, leaves shared names unbound and keeps operator edits", async () => {
    const first = await syncSetAssets(db);
    expect(first.added).toBeGreaterThan(0);
    expect((await syncSetAssets(db)).added).toBe(0);
    const asset = await findAssetForTopic(db, "Ascended Heroes");
    expect(asset).toMatchObject({ assetKey: "set:pokemon:asc", kind: "set", setId });
    const shared = await client.query<{ aliases: string[] }>(`SELECT aliases FROM market_asset WHERE asset_key LIKE 'set:pokemon:dup%'`);
    expect(shared.rows.map((row) => row.aliases)).toEqual([[], []]);
    const promo = await client.query(`SELECT 1 FROM market_asset WHERE asset_key = 'set:pokemon:svp'`);
    expect(promo.rows).toHaveLength(0);
  });

  it("scores a set call on the median move of the set's cards, with no look-ahead", async () => {
    // Posted 2026-01-01; judged after the default 30 days (2026-01-31).
    // At the deadline the cards are up 10%, 5% and 20% and down 2.5%: median
    // +7.5%. Prices after the deadline (12.00, 22.00, ... and the crash to 1)
    // must not be read.
    await prices(printings[0]!, "2025-12-31T12:00:00Z", [10, 10.5, ...Array(29).fill(11), 12]);
    await prices(printings[1]!, "2025-12-31T12:00:00Z", [20, ...Array(30).fill(21), 22]);
    await prices(printings[2]!, "2025-12-31T12:00:00Z", [5, ...Array(30).fill(6), 6.5]);
    await prices(printings[3]!, "2025-12-31T12:00:00Z", [40, ...Array(30).fill(39), 38]);
    for (const id of printings) await prices(id, "2026-02-10T12:00:00Z", [1]);

    await post("c_right", "sa_right", "2026-01-01T00:00:00Z", "Ascended Heroes is going up, buy now");
    const [result] = await extractAssetCallsFromContent(db, "c_right");
    expect(result).toMatchObject({ status: "processed" });

    const move = await setBasketMove(db, {
      setId,
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-31T00:00:00Z"),
    });
    expect(move?.printings).toBe(4);
    expect(move?.startAfterCall).toBe(false);
    expect(move!.ret).toBeCloseTo(0.075, 6);

    const report = await scoreDueCreatorCalls(db, { asOf: new Date("2026-02-15T00:00:00Z") });
    expect(report).toMatchObject({ evaluated: 1, creatorsRecomputed: 1 });
    const asset = await findAssetForTopic(db, "Ascended Heroes");
    const calls = await getTopicCalls(db, asset!.id);
    expect(calls).toMatchObject({ total: 1, evaluated: 1, correct: 1 });
    expect(calls.calls[0]?.returnPct).toBeCloseTo(0.075, 6);
    // A set has no single price to show.
    expect(calls.calls[0]?.priceAtCall).toBeNull();
    const outcome = await client.query<{ data_quality: string; starting_price: string | null }>(
      `SELECT o.data_quality, o.starting_price FROM creator_call_outcome o JOIN creator_call c ON c.id = o.call_id WHERE c.content_id = 'c_right'`,
    );
    expect(outcome.rows[0]).toMatchObject({ data_quality: "complete_default_horizon+set_card_median_n4", starting_price: null });
  });

  it("calls a stagnant set flat and counts it against the creator", async () => {
    // From 2026-03-01 every card stays within FLAT_BAND of where it started.
    const start = "2026-02-28T12:00:00Z";
    for (const [index, id] of printings.entries()) {
      const base = 10 * (index + 1);
      await prices(id, start, [base, ...Array(31).fill(base * (1 + FLAT_BAND / 2))]);
    }
    await post("c_flat", "sa_flat", "2026-03-01T00:00:00Z", "Ascended Heroes will go up");
    expect((await extractAssetCallsFromContent(db, "c_flat"))[0]?.status).toBe("processed");
    const report = await scoreDueCreatorCalls(db, { asOf: new Date("2026-04-05T00:00:00Z") });
    expect(report).toMatchObject({ evaluated: 1 });
    const outcome = await client.query<{ directional_correct: string; creator_id: string }>(
      `SELECT o.directional_correct, c.creator_id FROM creator_call_outcome o JOIN creator_call c ON c.id = o.call_id WHERE c.content_id = 'c_flat'`,
    );
    expect(outcome.rows[0]?.directional_correct).toBe("flat");
    const profile = await getCreatorAuthorityProfile(db, outcome.rows[0]!.creator_id);
    const overall = profile.slices.find((row) => row.gameKey === null && row.priceTier === "all");
    expect(overall?.formulaVersion).toBe("authority.v2");
    expect(Number(overall?.sampleSize)).toBe(1);
    expect(Number(overall?.successes)).toBe(0);
  });

  it("rebuilds a creator record made by an older formula", async () => {
    // Slices are append-only: an older formula's snapshot arrives as the newest row.
    await client.exec(`
      INSERT INTO creator_authority_slice (id, creator_id, price_tier, sample_size, successes, trust_state, formula_version, benchmark_requirement, created_at)
      SELECT DISTINCT ON (creator_id) 'old_' || creator_id, creator_id, 'all', 0, 0, 'low_confidence', 'authority.v1', 'test', created_at + interval '1 millisecond'
      FROM creator_authority_slice ORDER BY creator_id, created_at DESC`);
    const rebuilt = await scoreDueCreatorCalls(db, { asOf: new Date("2026-04-06T00:00:00Z") });
    expect(rebuilt?.creatorsRecomputed).toBe(2);
    const settled = await scoreDueCreatorCalls(db, { asOf: new Date("2026-04-07T00:00:00Z") });
    expect(settled?.creatorsRecomputed).toBe(0);
  });

  it("does not score a set with too few priced cards", async () => {
    const thin = await setBasketMove(db, {
      setId,
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-07-01T00:00:00Z"),
    });
    expect(thin).toBeNull();
  });

  it("treats a post that names a sealed product as a call on the product, not the set", async () => {
    await syncSealedProducts(db);
    await post("c_box", "sa_box", "2026-05-01T00:00:00Z", "Ascended Heroes Booster Box is going up, buy");
    const results = await extractAssetCallsFromContent(db, "c_box");
    const keys = await client.query<{ asset_key: string }>(
      `SELECT a.asset_key FROM creator_call c JOIN market_asset a ON a.id = c.asset_id WHERE c.content_id = 'c_box'`,
    );
    expect(results.every((row) => row.status === "processed")).toBe(true);
    expect(keys.rows.map((row) => row.asset_key)).toEqual(["sealed:pokemon:asc:booster_box"]);
  });

  it("reads set calls out of posts stored before the set assets existed, once", async () => {
    await post("c_old", "sa_right", "2025-11-01T00:00:00Z", "Ascended Heroes will go up in 3 months");
    const first = await rescanAssetCalls(db, { now: new Date(Date.now() + 1000) });
    expect(first.scanned).toBeGreaterThanOrEqual(1);
    expect(first.callsCreated).toBe(1);
    const again = await rescanAssetCalls(db, { now: new Date(Date.now() + 2000) });
    expect(again).toMatchObject({ scanned: 0, callsCreated: 0 });
    const call = await client.query<{ horizon_code: string }>(`SELECT horizon_code FROM creator_call WHERE content_id = 'c_old'`);
    expect(call.rows).toEqual([{ horizon_code: "90d" }]);
  });
});
