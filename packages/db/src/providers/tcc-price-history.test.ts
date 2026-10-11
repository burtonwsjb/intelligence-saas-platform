import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  evaluateCreatorCallOutcome,
  extractCreatorCallsFromContent,
  getChartSentiment,
  ingestSourceContentRecord,
  readMigrationSql,
  runChartSentimentBatch,
  seedTcgIdentityFixtures,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import {
  TCC_PRICE_HISTORY_PATH,
  collectTccPriceHistory,
  listChartHistoryTargets,
  planPriceHistoryRequests,
  priceHistoryCheckId,
  priceHistoryRecordId,
  priceHistoryRetryMinutes,
  syncTccPriceHistory,
  tccPriceHistoryChartItemsPerRun,
  usableHistoryPoints,
  type PriceHistoryTarget,
} from "./tcc-price-history.js";
import type { HttpTransport } from "./transport.js";

// The fixture call: "buy" Twilight Masquerade Greninja 214, posted
// 2026-01-02T12:00Z with a 30 day horizon (ends 2026-02-01T12:00Z), and no
// market prices at all, so it can be scored only once history arrives.
async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const seeded = await seedTcgIdentityFixtures(db);
  const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
  const [buyCall] = await extractCreatorCallsFromContent(db, buy.contentId!);
  return { client, db, seeded, callId: buyCall!.call!.id, printingId: buyCall!.call!.printingId! };
}

type Sent = { url: string; headers?: Record<string, string>; body: { items: Record<string, string>[]; from: string; to: string } };

function fakeTcc(answer: () => unknown, sent: Sent[]): HttpTransport {
  return {
    async fetch(url, init) {
      sent.push({ url, headers: init?.headers, body: JSON.parse(init!.body!) });
      return { status: 200, headers: {}, bodyText: JSON.stringify(answer()) };
    },
  };
}

const point = (date: string, market: number | null) => ({ date, market, low: market && market - 2, mid: market, high: market && market + 3 });

describe("TCG Card Central price history", () => {
  it("fetches history for unscored calls, skips pending/unavailable answers, writes daily reference prices once", async () => {
    const { client, db, callId, printingId } = await setup();
    const first = await evaluateCreatorCallOutcome(db, callId, new Date("2026-03-01T00:00:00Z"));
    expect(first).toMatchObject({ evaluationStatus: "insufficient_data" });

    const sent: Sent[] = [];
    const base = { baseUrl: "https://tcc.example.test/", token: "fixture-token", sleep: async () => {} };
    const now = new Date("2026-03-01T09:00:00Z");

    // TCC cannot answer yet: "unavailable" is treated like "pending" and retried later.
    const unavailable = await collectTccPriceHistory(db, {
      ...base,
      items: 100,
      now,
      transport: fakeTcc(() => ({ ok: true, histories: [{ status: "unavailable", reason: "upstream_down", points: [] }] }), sent),
    });
    expect(unavailable).toMatchObject({ printings: 1, requests: 1, ok: 0, pending: 1, written: 0 });
    expect(sent[0]!.url).toBe(`https://tcc.example.test${TCC_PRICE_HISTORY_PATH}`);
    expect(sent[0]!.headers?.authorization).toBe("Bearer fixture-token");
    expect(sent[0]!.body).toMatchObject({ from: "2025-12-30", to: "2026-02-01" });
    expect(sent[0]!.body.items).toEqual([
      expect.objectContaining({ kind: "card", game: "pokemon", set_name: "Twilight Masquerade", card_number: "214/167" }),
    ]);

    // Not asked again before its retry time.
    const early = await collectTccPriceHistory(db, { ...base, items: 100, now, transport: fakeTcc(() => ({}), sent) });
    expect(early).toMatchObject({ status: "skipped", reason: "nothing_to_fetch", requests: 0 });
    expect(sent).toHaveLength(1);

    // "pending" (TCC is backfilling) is skipped the same way.
    const later = new Date(now.getTime() + 12 * 3_600_000);
    const pending = await collectTccPriceHistory(db, {
      ...base,
      items: 100,
      now: later,
      transport: fakeTcc(() => ({ ok: true, histories: [{ status: "pending", points: [] }] }), sent),
    });
    expect(pending).toMatchObject({ requests: 1, pending: 1, written: 0 });

    const ready = new Date(later.getTime() + 12 * 3_600_000);
    const ok = await collectTccPriceHistory(db, {
      ...base,
      items: 100,
      now: ready,
      transport: fakeTcc(
        () => ({
          ok: true,
          from: "2025-12-30",
          to: "2026-02-01",
          histories: [
            {
              status: "ok",
              product_id: 11,
              group_name: "SV06: Twilight Masquerade",
              sub_type: "Normal",
              points: [
                point("2026-01-03", 43),
                point("2026-01-04", null), // no market price that day
                point("2026-01-15", 50), // outside every window: not kept
                point("2026-01-30", 55),
              ],
            },
          ],
        }),
        sent,
      ),
    });
    expect(ok).toMatchObject({ requests: 1, ok: 1, points: 2, written: 2, outcomesReset: 1 });

    const { rows } = await client.query<{ price: string; price_type: string; condition: string; observed_at: Date }>(
      `SELECT price, price_type, condition, observed_at FROM tcg_market_snapshot
       WHERE printing_id = $1 AND source_key = 'tcg_card_central' ORDER BY observed_at`,
      [printingId],
    );
    expect(rows.map((row) => [Number(row.price), row.price_type, row.condition])).toEqual([
      [43, "reference", "unknown"],
      [55, "reference", "unknown"],
    ]);
    const { rows: ingests } = await client.query<{ source_record_id: string }>(
      `SELECT source_record_id FROM tcg_market_ingest WHERE source_key = 'tcg_card_central' ORDER BY source_record_id`,
    );
    expect(ingests.map((row) => row.source_record_id)).toEqual([
      priceHistoryRecordId(printingId, "2026-01-03"),
      priceHistoryRecordId(printingId, "2026-01-30"),
    ]);

    // The call is now scored on the history: 43 two days after the post, 55 at the close.
    const scored = await evaluateCreatorCallOutcome(db, callId, ready);
    expect(scored).toMatchObject({ evaluationStatus: "evaluated", directionalCorrect: "correct" });
    expect(Number(scored?.startingPrice)).toBe(43);
    expect(Number(scored?.endingPrice)).toBe(55);

    // Covered: nothing is fetched again.
    const again = await collectTccPriceHistory(db, {
      ...base,
      items: 100,
      now: new Date(ready.getTime() + 48 * 3_600_000),
      transport: fakeTcc(() => ({}), sent),
    });
    expect(again).toMatchObject({ status: "skipped", requests: 0 });
    expect(sent).toHaveLength(3);
  });

  it("is off unless TCC is live with a URL and token", async () => {
    const untouched = {
      transaction: async () => {
        throw new Error("unexpected");
      },
    } as unknown as Database;
    expect(await syncTccPriceHistory(untouched, { env: {} })).toMatchObject({ status: "skipped", reason: "tcc_not_live" });
    expect(await syncTccPriceHistory(untouched, { env: { TCC_PRICE_HISTORY_ITEMS_PER_RUN: "0" } })).toMatchObject({
      status: "skipped",
      reason: "disabled",
    });
    expect(
      await syncTccPriceHistory(untouched, { env: { PROVIDER_TCG_CARD_CENTRAL_MODE: "live", TCC_API_BASE_URL: "", TCC_API_TOKEN: "" } }),
    ).toMatchObject({ status: "skipped", reason: "disabled_pending_credentials" });
  });
});

describe("price history planning", () => {
  const target = (printingId: string, from: string, to: string): PriceHistoryTarget => ({
    kind: "card",
    printingId,
    game: "pokemon",
    setKey: "twm",
    setName: "Twilight Masquerade",
    collectorNumber: "1",
    cardName: "Card",
    language: "en",
    variant: "normal",
    windows: [{ from, to }],
    needFrom: from,
    needTo: to,
    calls: 1,
  });

  it("groups at most 50 printings per request within 400 days", () => {
    const many = Array.from({ length: 60 }, (_, i) => target(`p${String(i).padStart(2, "0")}`, "2026-01-01", "2026-01-10"));
    const batches = planPriceHistoryRequests([...many, target("far", "2027-03-01", "2027-03-05")]);
    expect(batches.map((batch) => batch.targets.length)).toEqual([50, 10, 1]);
    expect(batches[2]).toMatchObject({ from: "2027-03-01", to: "2027-03-05" });
  });

  it("keeps only dated points with a positive market price inside a window", () => {
    const points = usableHistoryPoints(
      { windows: [{ from: "2026-01-01", to: "2026-01-03" }] },
      {
        status: "ok",
        points: [point("2026-01-01", 10), point("2026-01-02", 0), point("bad", 5), point("2026-01-04", 12)],
      },
    );
    expect([...points.keys()]).toEqual(["2026-01-01"]);
  });
});

type HistoryRequest = { items: Array<Record<string, string>>; from: string; to: string };

/** A fake feed that answers each item through `answer(item, request)`. */
function perItemTcc(answer: (item: Record<string, string>, request: HistoryRequest) => unknown, sent: HistoryRequest[]): HttpTransport {
  return {
    async fetch(_url, init) {
      const request = JSON.parse(init!.body!) as HistoryRequest;
      sent.push(request);
      return { status: 200, headers: {}, bodyText: JSON.stringify({ ok: true, histories: request.items.map((item) => answer(item, request)) }) };
    },
  };
}

/** One point a day from `from` to `to`, gently rising. */
function dailyPoints(from: string, to: string) {
  const out: ReturnType<typeof point>[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`), i = 0; at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000, i += 1) {
    out.push(point(new Date(at).toISOString().slice(0, 10), Math.round((20 + i * 0.05) * 100) / 100));
  }
  return out;
}

async function checkpointOf(client: PGlite, printingId: string) {
  const { rows } = await client.query<{ checkpoint: Record<string, unknown> }>(`SELECT checkpoint FROM provider_sync_run WHERE id = $1`, [
    priceHistoryCheckId(printingId),
  ]);
  return rows[0]?.checkpoint ?? null;
}

const MINUTE = 60_000;

/** Puts a printing in an open index, the chart universe's second tier. */
async function indexMember(client: PGlite, printingId: string) {
  await client.query(
    `INSERT INTO tcg_index_definition (index_key, name, game_key, membership_rule, weighting_method, method_version)
     VALUES ('fixture_index', 'Fixture', 'pokemon', '{}'::jsonb, 'equal', 'v1') ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO tcg_index_membership (id, index_key, printing_id, effective_from, weight, method_version)
     VALUES ($1, 'fixture_index', $2, '2026-01-01', 1, 'v1')`,
    [`m_${printingId}`, printingId],
  );
}

describe("price history chart universe", () => {
  it("orders called printings, then index members, then the catalog by newest set; English Pokemon / One Piece only", async () => {
    const { client, db, seeded } = await setup();
    const p = seeded.printings;
    await client.query(`UPDATE tcg_set SET release_date = '2024-06-01' WHERE canonical_set_key = 'sv2'`);
    await indexMember(client, p.charizardPromo.id);
    const now = new Date("2026-03-01T09:00:00Z");
    const first = await listChartHistoryTargets(db, { now, limit: 4 });
    // The fixture call names English Greninja; the index holds the promo; then the catalog
    // alternates games: Paldea Evolved is the newest Pokemon set, Luffy the first One Piece card.
    expect(first.map((t) => t.printingId)).toEqual([p.greninjaEnNormal.id, p.charizardPromo.id, p.pikachuSv2.id, p.luffyEn.id]);
    expect(first[0]).toMatchObject({ chart: true, needFrom: "2025-03-01", needTo: "2026-02-28", windows: [{ from: "2025-03-01", to: "2026-02-28" }] });

    const all = await listChartHistoryTargets(db, { now, limit: 100 });
    const ids = new Set(all.map((t) => t.printingId));
    expect(all).toHaveLength(12);
    for (const other of [p.greninjaJaNormal, p.greninjaZhNormal, p.luffyJa]) expect(ids.has(other.id)).toBe(false);
    expect(ids.has(p.luffyEn.id)).toBe(true);

    const without = await listChartHistoryTargets(db, { now, limit: 1, exclude: new Set([p.greninjaEnNormal.id]) });
    expect(without.map((t) => t.printingId)).toEqual([p.charizardPromo.id]);
    expect(await listChartHistoryTargets(db, { now, limit: 0 })).toEqual([]);
  });

  it("asks for a year after the call printings, retries pending in ~30 min, backs off games without a source, refreshes daily, feeds Chart Sentiment", async () => {
    const { client, db, seeded } = await setup();
    const luffy = seeded.printings.luffyEn.id;
    const greninja = seeded.printings.greninjaEnNormal.id;
    // Make Luffy the first chart printing after the called Greninja.
    await indexMember(client, luffy);
    const base = { baseUrl: "https://tcc.example.test", token: "fixture-token", sleep: async () => {}, items: 100 };
    const sent: HistoryRequest[] = [];
    const t0 = new Date("2026-03-01T09:00:00Z");

    // Run 1: Greninja (call set) has no history source; Luffy (chart set) is queued at TCC.
    const first = await collectTccPriceHistory(db, {
      ...base,
      chartItems: 1,
      now: t0,
      transport: perItemTcc(
        (item) =>
          item.game === "one_piece"
            ? { status: "pending", reason: "history backfill queued", points: [] }
            : { status: "unavailable", reason: "no historical price source for this game yet", points: [] },
        sent,
      ),
    });
    expect(first).toMatchObject({ printings: 2, chartPrintings: 1, requests: 2, pending: 2, written: 0 });
    // Call printings are asked first, in their own request.
    expect(sent[0]!.items).toEqual([expect.objectContaining({ game: "pokemon", card_number: "214/167" })]);
    expect(sent[1]).toMatchObject({ from: "2025-03-01", to: "2026-02-28", items: [expect.objectContaining({ game: "one_piece", card_number: "OP01-001" })] });
    const noSource = Date.parse(String((await checkpointOf(client, greninja))!.next_attempt_at));
    expect(noSource - t0.getTime()).toBe(7 * 24 * 60 * MINUTE);
    const pendingAt = Date.parse(String((await checkpointOf(client, luffy))!.next_attempt_at));
    expect(pendingAt - t0.getTime()).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(pendingAt - t0.getTime()).toBeLessThanOrEqual(45 * MINUTE);

    // Run 2, 50 minutes later: only Luffy is due, and its year arrives.
    const t1 = new Date(t0.getTime() + 50 * MINUTE);
    const year = dailyPoints("2025-02-27", "2026-02-28"); // two days before the range are dropped
    const second = await collectTccPriceHistory(db, {
      ...base,
      chartItems: 1,
      now: t1,
      transport: perItemTcc(() => ({ status: "ok", product_id: 501, group_name: "Romance Dawn", sub_type: "Normal", points: year }), sent),
    });
    expect(second).toMatchObject({ printings: 1, chartPrintings: 1, requests: 1, ok: 1, points: 365, written: 365, deferred: 0 });
    expect(sent[2]!.items).toEqual([expect.objectContaining({ game: "one_piece" })]);
    expect(await checkpointOf(client, luffy)).toMatchObject({ status: "ok", chart_to: "2026-02-28", covered_from: "2025-03-01", covered_to: "2026-02-28" });

    // Not asked again the same day.
    const same = await listChartHistoryTargets(db, { now: new Date(t1.getTime() + 60 * MINUTE), limit: 1 });
    expect(same.map((t) => t.printingId)).not.toContain(luffy);

    // Next day: only the latest days are asked for, and only the new day is written.
    const t2 = new Date(t1.getTime() + 25 * 60 * MINUTE);
    const refresh = await collectTccPriceHistory(db, {
      ...base,
      chartItems: 1,
      now: t2,
      transport: perItemTcc(() => ({ status: "ok", product_id: 501, points: dailyPoints("2025-02-27", "2026-03-01").slice(-5) }), sent),
    });
    expect(sent[3]).toMatchObject({ from: "2026-02-25", to: "2026-03-01" });
    expect(refresh).toMatchObject({ requests: 1, ok: 1, points: 5, written: 1 });
    expect(await checkpointOf(client, luffy)).toMatchObject({ chart_to: "2026-03-01", covered_from: "2025-03-01", covered_to: "2026-03-01" });

    // Chart Sentiment picks the printing up and reads the whole year into its raw segment.
    const chart = await runChartSentimentBatch(db, { asOf: new Date("2026-03-02T12:00:00Z"), batchSize: 10 });
    expect(chart).toMatchObject({ considered: 1, printings: 1 });
    const stored = (await getChartSentiment(db, [luffy])).get(luffy)!;
    expect(stored.raw).toMatchObject({ segment: "raw", priceType: "reference", currency: "USD", points: 366, dataThrough: "2026-03-01" });
    expect(stored.raw!.label).not.toBe("insufficient_history");
  }, 90_000);

  it("defers a whole printing at the points cap instead of writing part of it", async () => {
    const { client, db, seeded } = await setup();
    await indexMember(client, seeded.printings.luffyEn.id);
    const now = new Date("2026-03-01T09:00:00Z");
    const sent: HistoryRequest[] = [];
    const report = await collectTccPriceHistory(db, {
      baseUrl: "https://tcc.example.test",
      token: "fixture-token",
      sleep: async () => {},
      items: 0,
      chartItems: 2,
      maxPoints: 400,
      now,
      transport: perItemTcc(() => ({ status: "ok", points: dailyPoints("2025-03-01", "2026-02-28") }), sent),
    });
    expect(report).toMatchObject({ status: "stopped", reason: "points_cap", printings: 2, requests: 1, ok: 2, written: 365, deferred: 1 });
    // The called Greninja is the first chart printing and is written whole; the
    // second (Luffy, an index member) is deferred with nothing written.
    expect(await checkpointOf(client, seeded.printings.greninjaEnNormal.id)).toMatchObject({ status: "ok", chart_to: "2026-02-28" });
    const luffy = seeded.printings.luffyEn.id;
    const deferred = (await checkpointOf(client, luffy))!;
    expect(deferred).toMatchObject({ status: "deferred", reason: "points_cap", chart_to: null, covered_from: null, points_written: 0 });
    const wait = Date.parse(String(deferred.next_attempt_at)) - now.getTime();
    expect(wait >= 30 * MINUTE && wait <= 45 * MINUTE).toBe(true);
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM tcg_market_snapshot WHERE printing_id = $1`, [luffy]);
    expect(rows[0]!.n).toBe(0);
    // Half an hour later it is asked again.
    const later = await listChartHistoryTargets(db, { now: new Date(now.getTime() + 46 * MINUTE), limit: 1 });
    expect(later.map((t) => t.printingId)).toEqual([luffy]);
  }, 90_000);

  it("times retries by answer", () => {
    expect(priceHistoryRetryMinutes("pending", "history backfill queued", 0)).toBe(30);
    expect(priceHistoryRetryMinutes("pending", null, 0.9999)).toBe(45);
    expect(priceHistoryRetryMinutes("unavailable", "price history unavailable", 0)).toBe(30);
    expect(priceHistoryRetryMinutes("unavailable", "No historical price source for this game yet", 0.5)).toBe(7 * 24 * 60);
    expect(priceHistoryRetryMinutes("deferred", "points_cap", 0)).toBe(30);
    expect(priceHistoryRetryMinutes("ok", null, 0.5)).toBe(24 * 60);
    expect(priceHistoryRetryMinutes("not_found", "set not found", 0.5)).toBe(30 * 24 * 60);
    expect(priceHistoryRetryMinutes("invalid", null)).toBe(7 * 24 * 60);
    expect(priceHistoryRetryMinutes("something_else", null)).toBe(24 * 60);
  });

  it("reads the chart universe size from env", () => {
    expect(tccPriceHistoryChartItemsPerRun({})).toBe(150);
    expect(tccPriceHistoryChartItemsPerRun({ TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN: "0" })).toBe(0);
    expect(tccPriceHistoryChartItemsPerRun({ TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN: "40" })).toBe(40);
    expect(() => tccPriceHistoryChartItemsPerRun({ TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN: "501" })).toThrow();
    expect(() => tccPriceHistoryChartItemsPerRun({ TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN: "-1" })).toThrow();
  });
});
