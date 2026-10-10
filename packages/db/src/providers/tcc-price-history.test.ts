import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  evaluateCreatorCallOutcome,
  extractCreatorCallsFromContent,
  ingestSourceContentRecord,
  readMigrationSql,
  seedTcgIdentityFixtures,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import {
  TCC_PRICE_HISTORY_PATH,
  collectTccPriceHistory,
  planPriceHistoryRequests,
  priceHistoryRecordId,
  syncTccPriceHistory,
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
  await seedTcgIdentityFixtures(db);
  const buy = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
  const [buyCall] = await extractCreatorCallsFromContent(db, buy.contentId!);
  return { client, db, callId: buyCall!.call!.id, printingId: buyCall!.call!.printingId! };
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
