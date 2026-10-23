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
  listSentimentEvidence,
  SENTIMENT_BASELINE_WEIGHT,
  listCardCreatorCalls,
  listCardEvidence,
  listCardExplorerPage,
  listExplorerFacets,
  marketConfirmationState,
  scoredPriceBasis,
  parseExplorerQuery,
  primaryDriver,
  explanationSentence,
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
        { printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive", weight: 0.05, rated: false },
        { printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive", weight: 0.05, rated: false },
        { printingId: "p", contentId: "c2", accountId: "a1", sentiment: "positive", weight: 0.05, rated: false },
        { printingId: "p", contentId: "c3", accountId: "a2", sentiment: "negative", weight: 0.05, rated: false },
        { printingId: "p", contentId: "c3", accountId: "a2", sentiment: "positive", weight: 0.05, rated: false },
        { printingId: "p", contentId: "c4", accountId: "a3", sentiment: "unknown", weight: 0.05, rated: false },
      ],
      range,
    );
    expect(summary.counts).toEqual({ positive: 2, neutral: 0, negative: 0, mixed: 1 });
    expect(summary.unknown).toBe(1);
    expect(summary.classified).toBe(3);
    expect(summary.contentItems).toBe(4);
    expect(summary.uniqueAccounts).toBe(3);
    expect(summary.basis).toBe("accuracy_weighted");
    expect(summary.ratedPosts).toBe(0);
  });

  it("lets accurate creators outweigh unrated accounts and inaccurate ones count less", () => {
    const row = (contentId: string, sentiment: string, weight: number, rated: boolean) => ({
      printingId: "p",
      contentId,
      accountId: `a-${contentId}`,
      sentiment,
      weight,
      rated,
    });
    const summary = summarizeSentiment(
      [
        row("c1", "positive", 0.6, true),
        row("c2", "negative", 0.05, false),
        row("c3", "negative", 0.05, false),
        row("c4", "negative", 0.05, false),
        row("c5", "negative", 0.01, true),
      ],
      range,
    );
    expect(summary.counts).toEqual({ positive: 1, neutral: 0, negative: 4, mixed: 0 });
    expect(summary.weighted.positive).toBeCloseTo(0.6);
    expect(summary.weighted.negative).toBeCloseTo(0.16);
    expect(summary.ratedPosts).toBe(2);
    expect(summary.label).toBe("mostly_positive");
  });

  it("falls back to one vote per post when every creator's track record weighs 0", () => {
    const summary = summarizeSentiment(
      [
        { printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive", weight: 0, rated: true },
        { printingId: "p", contentId: "c2", accountId: "a1", sentiment: "unknown", weight: 0, rated: true },
      ],
      range,
    );
    expect(summary.classified).toBe(1);
    expect(summary.weighted.positive).toBe(1);
    expect(summary.weightTotal).toBe(1);
    expect(summary.label).toBe("too_few");
  });

  it("needs enough posts even when one creator carries a lot of weight", () => {
    const summary = summarizeSentiment(
      [{ printingId: "p", contentId: "c1", accountId: "a1", sentiment: "positive", weight: 0.9, rated: true }],
      range,
    );
    expect(summary.label).toBe("too_few");
  });

  it("never turns missing evidence into neutral", () => {
    const empty = summarizeSentiment([], range);
    expect(empty.label).toBe("no_evidence");
    expect(sentimentLabel({ positive: 2, neutral: 0, negative: 0, mixed: 0 }, 2, 2)).toBe("too_few");
    expect(sentimentLabel({ positive: 4, neutral: 1, negative: 0, mixed: 0 }, 5, 5)).toBe("mostly_positive");
    expect(sentimentLabel({ positive: 2, neutral: 0, negative: 2, mixed: 0 }, 4, 4)).toBe("divided");
  });
});

describe("score and price helpers", () => {
  it("reports market confirmation as its own state", () => {
    expect(marketConfirmationState(null)).toBe("no_score");
    expect(scoredPriceBasis({ price_basis: "reference", price_points: 14 })).toEqual({ basis: "reference", points: 14 });
    expect(scoredPriceBasis({})).toBeNull();
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
    ).toBe("Price up 4.0% over 7 days");
    expect(primaryDriver(null)).toBeNull();
  });

  it("leads with creator calls and rewrites old internal wording as plain sentences", () => {
    expect(
      primaryDriver([
        { code: "price_return_7d", text: "price -2.5% over 7d" },
        { code: "creator_consensus", text: "authority-weighted creator consensus bullish (n=6)" },
      ]),
    ).toBe("6 creator calls on this card");
    expect(explanationSentence({ code: "creator_consensus", text: "authority-weighted creator consensus bearish (n=1)" })).toBe(
      "1 creator call lean bearish",
    );
    expect(explanationSentence({ code: "price_return_7d", text: "price -2.5% over 7d" })).toBe("Price down 2.5% over 7 days");
    expect(explanationSentence({ code: "liquidity", text: "liquidity weak" })).toBe("Sells slowly");
    expect(explanationSentence({ code: "relative_strength", text: "relative strength -1.2% vs benchmark" })).toBe(
      "Trailing similar cards by 1.2%",
    );
    expect(explanationSentence({ code: "listings", text: "active listings +3" })).toBe("3 more copies listed for sale");
    expect(explanationSentence({ code: "volatility", text: "volatility elevated" })).toBe("Price swings a lot");
    // New-model sentences pass through unchanged.
    expect(explanationSentence({ code: "creator_consensus", text: "6 creator calls lean bullish, weighted by each creator's track record" })).toBe(
      "6 creator calls lean bullish, weighted by each creator's track record",
    );
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
        expect(["sold", "reference"]).toContain(row.price.quoteType);
        expect(row.price.currency).toMatch(/^[A-Z]{3}$/);
      }
    }
    // Fixture sales are from early January: today they are too old to headline, so
    // priced cards fall back to the TCGplayer market price; on the sale date the sale wins.
    expect(all.rows.some((row) => row.price?.quoteType === "sold")).toBe(false);
    const thatWeek = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48" }), {
      now: new Date("2026-01-06T00:00:00Z"),
    });
    expect(thatWeek.rows.some((row) => row.price?.quoteType === "sold")).toBe(true);

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

  it("weights a post by its creator's latest authority slice and leaves unrated accounts at the baseline", async () => {
    const db = await setup();
    const wide = { from: new Date("2000-01-01T00:00:00Z"), to: new Date("2100-01-01T00:00:00Z") };
    const printings = (await db.execute(sql`
      SELECT DISTINCT chosen_printing_id AS id FROM entity_resolution_attempt WHERE chosen_printing_id IS NOT NULL
    `)) as unknown as { rows: { id: string }[] };
    const ids = printings.rows.map((row) => row.id);
    const before = await listSentimentEvidence(db, ids, wide);
    expect(before.length).toBeGreaterThan(0);
    const linked = (await db.execute(sql`
      SELECT csa.creator_id, csa.source_account_id FROM creator_source_account csa
      WHERE csa.source_account_id IN (${sql.join(
        [...new Set(before.map((row) => row.accountId))].map((id) => sql`${id}`),
        sql`, `,
      )})
      LIMIT 1
    `)) as unknown as { rows: { creator_id: string; source_account_id: string }[] };
    const target = linked.rows[0];
    expect(target).toBeTruthy();
    await db.execute(sql`
      INSERT INTO creator_authority_slice (id, creator_id, language_code, price_tier, sample_size, successes,
        authority_weight, trust_state, formula_version, benchmark_requirement, created_at)
      VALUES ('slice-weight-test', ${target!.creator_id}, NULL, 'all', 40, 32, 0.612345, 'trusted', 'authority.v1',
        'test', '2099-01-01T00:00:00Z')
    `);
    const after = await listSentimentEvidence(db, ids, wide);
    for (const row of after) {
      if (row.accountId === target!.source_account_id) {
        expect(row.rated).toBe(true);
        expect(row.weight).toBeCloseTo(0.612345);
      }
    }
    const unrated = after.filter((row) => !row.rated);
    for (const row of unrated) expect(row.weight).toBe(SENTIMENT_BASELINE_WEIGHT);
  });

  it("filters and sorts by market and social sentiment in SQL, matching the card summaries", async () => {
    const db = await setup();
    const latest = (await db.execute(sql`SELECT max(published_at) AS at FROM source_content`)) as unknown as {
      rows: { at: string | Date }[];
    };
    const now = new Date(new Date(latest.rows[0]!.at).getTime() + 86_400_000);
    const options = { now };
    const base = { pageSize: "48", window: "90d" };
    const all = await listCardExplorerPage(db, parseExplorerQuery(base), options);
    const withPosts = all.rows.filter((row) => row.sentiment.classified > 0);
    expect(withPosts.length).toBeGreaterThan(0);

    const any = await listCardExplorerPage(db, parseExplorerQuery({ ...base, social: "any" }), options);
    expect(any.total).toBe(withPosts.length);
    expect(any.rows.every((row) => row.sentiment.classified > 0)).toBe(true);
    const none = await listCardExplorerPage(db, parseExplorerQuery({ ...base, social: "none" }), options);
    expect(none.total).toBe(all.total - withPosts.length);

    const lean = (row: (typeof all.rows)[number]) => row.sentiment.weighted.positive - row.sentiment.weighted.negative;
    const positive = await listCardExplorerPage(db, parseExplorerQuery({ ...base, social: "positive" }), options);
    expect(positive.total).toBe(withPosts.filter((row) => lean(row) > 0).length);
    expect(positive.rows.every((row) => lean(row) > 0)).toBe(true);
    const negative = await listCardExplorerPage(db, parseExplorerQuery({ ...base, social: "negative" }), options);
    expect(negative.rows.every((row) => lean(row) < 0)).toBe(true);

    const talked = await listCardExplorerPage(db, parseExplorerQuery({ ...base, sort: "social_posts" }), options);
    const counts = talked.rows.map((row) => row.sentiment.classified);
    expect(counts.slice(0, withPosts.length)).toEqual([...counts.slice(0, withPosts.length)].sort((a, b) => b - a));

    const step: Record<string, number> = { strong_buy: 4, buy: 3, hold: 2, watch: 2, reduce: 1, sell: 1, strong_sell: 0 };
    const buyFirst = await listCardExplorerPage(db, parseExplorerQuery({ ...base, sort: "market_buy" }), options);
    const steps = buyFirst.rows.map((row) => step[row.score?.recommendation ?? ""]).filter((value) => value != null);
    expect(steps).toEqual([...steps].sort((a, b) => b - a));
    const buys = await listCardExplorerPage(db, parseExplorerQuery({ ...base, market: "buy" }), options);
    expect(buys.rows.every((row) => ["buy", "strong_buy"].includes(row.score!.recommendation))).toBe(true);
    const noReading = await listCardExplorerPage(db, parseExplorerQuery({ ...base, market: "none" }), options);
    expect(noReading.rows.every((row) => row.score == null || row.score.recommendation === "insufficient_data")).toBe(true);
  });

  // Runs last in this block: calls are append-only, so it adds a graded copy rather than editing one.
  it("splits a card's creator calls into raw and graded and links each to its post", async () => {
    const db = await setup();
    const found = (await db.execute(sql`
      SELECT id, printing_id FROM creator_call WHERE printing_id IS NOT NULL AND content_id IS NOT NULL
      ORDER BY id LIMIT 1
    `)) as unknown as { rows: { id: string; printing_id: string }[] };
    const call = found.rows[0];
    expect(call).toBeTruthy();
    const before = await listCardCreatorCalls(db, call!.printing_id);
    expect(before.items.every((item) => item.grade === null)).toBe(true);
    expect(before.items.find((item) => item.id === call!.id)?.contentUrl).toMatch(/^https?:\/\//);
    await db.execute(sql`CREATE TEMP TABLE graded_call AS SELECT * FROM creator_call WHERE id = ${call!.id}`);
    await db.execute(sql`UPDATE graded_call SET id = 'graded-copy', fingerprint = 'graded-copy', mention_id = NULL,
      evidence = evidence || '{"grade":{"company":"psa","grade":10}}'::jsonb`);
    await db.execute(sql`INSERT INTO creator_call SELECT * FROM graded_call`);
    const raw = await listCardCreatorCalls(db, call!.printing_id, { kind: "raw" });
    const graded = await listCardCreatorCalls(db, call!.printing_id, { kind: "graded" });
    expect(raw.items.some((item) => item.id === "graded-copy")).toBe(false);
    expect(graded.items.map((item) => [item.id, item.grade])).toEqual([["graded-copy", "PSA 10"]]);
    expect(graded.items[0]!.contentUrl).toMatch(/^https?:\/\//);
    expect(graded.counts).toEqual({ raw: before.counts.raw, graded: before.counts.graded + 1 });
  });
});
