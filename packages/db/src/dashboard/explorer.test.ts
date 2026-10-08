import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readMigrationSql, type Database } from "../index.js";
import { runStagingFixturePipeline } from "../platform/staging-fixture.js";
import {
  EXPLORER_MAX_PAGE_SIZE,
  comparableSoldSeries,
  explorerQueryToSearch,
  getCardSentiment,
  listCardCreatorCalls,
  listCardEvidence,
  listCardExplorerPage,
  listExplorerFacets,
  marketConfirmationState,
  parseExplorerQuery,
  primaryDriver,
  sentimentLabel,
  summarizeSentiment,
  windowChange,
} from "./explorer.js";

const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") };

describe("explorer query parsing", () => {
  it("drops invalid values instead of guessing", () => {
    const query = parseExplorerQuery({
      q: "  charizard ",
      view: "everything",
      sort: "random",
      pageSize: "1000",
      page: "-4",
      minOpportunity: "140",
      maxRisk: "40",
      game: "pokemon'; drop table x",
      minPrice: "10",
    });
    expect(query.q).toBe("charizard");
    expect(query.view).toBe("all");
    expect(query.sort).toBe("opportunity");
    expect(query.pageSize).toBe(24);
    expect(query.page).toBe(1);
    expect(query.minOpportunity).toBeUndefined();
    expect(query.maxRisk).toBe(40);
    expect(query.game).toBeUndefined();
    // A price bound without a currency would mix currencies, so it is ignored.
    expect(query.minPrice).toBeUndefined();
  });

  it("keeps price bounds only with an explicit currency and round-trips URL state", () => {
    const query = parseExplorerQuery({ priceCurrency: "usd", minPrice: "5", view: "caution", mode: "table", page: "3" });
    expect(query.priceCurrency).toBe("USD");
    expect(query.minPrice).toBe(5);
    const search = explorerQueryToSearch(query);
    expect(search).toBe("?view=caution&priceCurrency=USD&minPrice=5&mode=table&page=3");
    expect(parseExplorerQuery(Object.fromEntries(new URLSearchParams(search)))).toEqual(query);
    expect(explorerQueryToSearch(query, { page: 1 })).not.toContain("page=");
  });
});

describe("sentiment summary", () => {
  it("counts one vote per content item and keeps unknown separate", () => {
    const summary = summarizeSentiment(
      [
        { printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive" },
        { printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive" },
        { printingId: "p", contentId: "c2", accountId: "a1", sentiment: "positive" },
        { printingId: "p", contentId: "c3", accountId: "a2", sentiment: "negative" },
        { printingId: "p", contentId: "c3", accountId: "a2", sentiment: "positive" },
        { printingId: "p", contentId: "c4", accountId: "a3", sentiment: "unknown" },
      ],
      range,
    );
    expect(summary.counts).toEqual({ positive: 2, neutral: 0, negative: 0, mixed: 1 });
    expect(summary.unknown).toBe(1);
    expect(summary.classified).toBe(3);
    expect(summary.contentItems).toBe(4);
    expect(summary.uniqueAccounts).toBe(3);
    expect(summary.basis).toBe("unweighted_content");
  });

  it("never turns missing evidence into neutral", () => {
    const empty = summarizeSentiment([], range);
    expect(empty.label).toBe("no_evidence");
    expect(sentimentLabel({ positive: 2, neutral: 0, negative: 0, mixed: 0 }, 2)).toBe("too_few");
    expect(sentimentLabel({ positive: 4, neutral: 1, negative: 0, mixed: 0 }, 5)).toBe("mostly_positive");
    expect(sentimentLabel({ positive: 2, neutral: 0, negative: 2, mixed: 0 }, 4)).toBe("divided");
  });
});

describe("score and price helpers", () => {
  it("reports market confirmation as its own state", () => {
    expect(marketConfirmationState(null)).toBe("no_score");
    expect(marketConfirmationState({ dataQuality: "insufficient_data", marketConfirmed: true })).toBe("insufficient");
    expect(marketConfirmationState({ dataQuality: "ok", marketConfirmed: false })).toBe("unconfirmed");
    expect(marketConfirmationState({ dataQuality: "ok", marketConfirmed: true })).toBe("confirmed");
  });

  it("uses the first evidence driver, not the recommendation echo", () => {
    expect(
      primaryDriver([
        { code: "recommendation", text: "recommendation watch" },
        { code: "price_return_7d", text: "price +4.0% over 7d" },
      ]),
    ).toBe("price +4.0% over 7d");
    expect(primaryDriver(null)).toBeNull();
  });

  it("needs two comparable observations for a change and excludes non-comparable rows", () => {
    expect(windowChange([{ observedAt: range.from, amount: 10 }])).toBeNull();
    expect(
      windowChange([
        { observedAt: range.from, amount: 10 },
        { observedAt: range.to, amount: 12 },
      ]),
    ).toBeCloseTo(0.2);
    const base = { gradingCompany: null, outlierFlag: false, condition: "nm", currency: "USD" };
    const split = comparableSoldSeries(
      [
        { ...base, price: "12", observedAt: range.to },
        { ...base, price: "10", observedAt: range.from },
        { ...base, price: "900", outlierFlag: true, observedAt: range.from },
        { ...base, price: "1500", currency: "JPY", observedAt: range.from },
        { ...base, price: "40", gradingCompany: "PSA", observedAt: range.from },
      ],
      { currency: "USD", condition: "nm" },
    );
    expect(split.points.map((point) => point.amount)).toEqual([10, 12]);
    expect(split.outliers).toBe(1);
    expect(split.otherGroups).toBe(2);
  });
});

describe("card explorer against the canonical pipeline", () => {
  let shared: Promise<Database> | null = null;
  function setup() {
    shared ??= (async () => {
      const client = new PGlite();
      await client.exec(await readMigrationSql());
      const db = drizzle(client) as unknown as Database;
      await runStagingFixturePipeline(db);
      return db;
    })();
    return shared;
  }

  it("pages exact printings in SQL with persisted scores and comparable prices", async () => {
    const db = await setup();
    const all = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48" }));
    expect(all.total).toBeGreaterThan(0);
    expect(all.rows.length).toBe(Math.min(all.total, 48));
    const scored = all.rows.filter((row) => row.score);
    expect(scored.length).toBeGreaterThan(0);
    // Unscored catalog cards stay visible rather than being hidden.
    const counted = (await db.execute(
      sql`SELECT count(*)::int AS printings FROM tcg_printing WHERE status = 'active'`,
    )) as unknown as { rows: { printings: number }[] };
    expect(all.total).toBe(counted.rows[0]!.printings);
    for (const row of all.rows) {
      if (row.price) {
        expect(row.price.quoteType).toBe("sold");
        expect(row.price.currency).toMatch(/^[A-Z]{3}$/);
      }
    }

    const small = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "12" }));
    expect(small.rows.length).toBeLessThanOrEqual(12);
    const capped = await listCardExplorerPage(db, { ...parseExplorerQuery({}), pageSize: 500 });
    expect(capped.pageSize).toBe(EXPLORER_MAX_PAGE_SIZE);

    const past = await listCardExplorerPage(db, parseExplorerQuery({ page: "400" }));
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(all.total);
  });

  it("filters by language, search and view presets before paging", async () => {
    const db = await setup();
    const all = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48" }));
    const language = all.rows[0]!.languageCode;
    const byLanguage = await listCardExplorerPage(db, parseExplorerQuery({ language, pageSize: "48" }));
    expect(byLanguage.rows.every((row) => row.languageCode === language)).toBe(true);

    const name = all.rows[0]!.cardName;
    const search = await listCardExplorerPage(db, parseExplorerQuery({ q: name.slice(0, 4), pageSize: "48" }));
    expect(search.rows.some((row) => row.printingId === all.rows[0]!.printingId)).toBe(true);
    const wildcard = await listCardExplorerPage(db, parseExplorerQuery({ q: "%" }));
    expect(wildcard.total).toBe(0);

    const opportunities = await listCardExplorerPage(db, parseExplorerQuery({ view: "opportunities", pageSize: "48" }));
    expect(opportunities.rows.every((row) => row.score && row.score.opportunity >= 60)).toBe(true);
    const confirmed = await listCardExplorerPage(db, parseExplorerQuery({ view: "confirmed", pageSize: "48" }));
    expect(confirmed.rows.every((row) => row.score?.marketConfirmed === true)).toBe(true);

    const sorted = await listCardExplorerPage(db, parseExplorerQuery({ sort: "risk_low", pageSize: "48" }));
    const risks = sorted.rows.filter((row) => row.score).map((row) => row.score!.risk);
    expect(risks).toEqual([...risks].sort((a, b) => a - b));

    const facets = await listExplorerFacets(db);
    expect(facets.languages.length).toBeGreaterThan(0);
    expect(facets.games.length).toBeGreaterThan(0);
  });

  it("summarizes resolved social evidence and pages detail panels", async () => {
    const db = await setup();
    const resolved = (await db.execute(sql`
      SELECT chosen_printing_id AS printing_id FROM entity_resolution_attempt
      WHERE chosen_printing_id IS NOT NULL AND status IN ('exact', 'high_confidence') LIMIT 1
    `)) as unknown as { rows: { printing_id: string }[] };
    const printingId = resolved.rows[0]?.printing_id;
    expect(printingId).toBeTruthy();
    const sentiment = await getCardSentiment(db, printingId!, "90d", { now: new Date("2100-01-01T00:00:00Z") });
    expect(sentiment.classified + sentiment.unknown).toBe(sentiment.contentItems);
    const evidence = await listCardEvidence(db, printingId!);
    expect(evidence.items.length).toBeGreaterThan(0);
    expect(evidence.items.length).toBeLessThanOrEqual(10);
    const calls = await listCardCreatorCalls(db, printingId!);
    expect(calls.items.length).toBeLessThanOrEqual(10);
  });
});
