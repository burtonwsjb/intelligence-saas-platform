import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  applyMigrations,
  assertDisposableAdminUrl,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  testRolePasswords,
} from "../index.js";
import { runStagingFixturePipeline } from "../platform/staging-fixture.js";
import {
  getCardSentiment,
  listCardEvidence,
  listCardExplorerPage,
  listExplorerFacets,
  listIndexSummaries,
  listSetSummaries,
  parseExplorerQuery,
} from "./explorer.js";

// The explorer uses raw SQL, so it is exercised through the production driver
// (postgres-js) and the runtime app_user role, not only through PGlite.
describe("card explorer on PostgreSQL as app_user", () => {
  const passwords = testRolePasswords();
  const name = `explorer_${randomUUID().replaceAll("-", "")}`;
  let root: ReturnType<typeof postgres>;
  let created = false;
  let adminConn: ReturnType<typeof createDbConnection> | undefined;
  let appConn: ReturnType<typeof createDbConnection> | undefined;

  beforeAll(async () => {
    const adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    root = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
    await root.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const target = new URL(adminUrl);
    target.pathname = `/${name}`;
    await applyMigrations(target.toString());
    await bootstrapRoles(target.toString(), passwords);
    adminConn = createDbConnection(target.toString());
    await runStagingFixturePipeline(adminConn.db);
    appConn = createDbConnection(replaceConnectionRole(target.toString(), DB_ROLES.user, passwords.user));
  });

  afterAll(async () => {
    await appConn?.end();
    await adminConn?.end();
    if (created) await root.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await root?.end({ timeout: 5 });
  });

  it("pages, filters and summarizes with timestamp and numeric parameters bound by the driver", async () => {
    const db = appConn!.db;
    const page = await listCardExplorerPage(
      db,
      parseExplorerQuery({ pageSize: "12", window: "90d", maxRisk: "100", q: "a", sort: "price_low" }),
    );
    expect(page.total).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThanOrEqual(12);
    const scoredFirst = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48" }));
    const priced = scoredFirst.rows.find((row) => row.price);
    expect(priced?.price?.observedAt).toBeInstanceOf(Date);

    const facets = await listExplorerFacets(db);
    expect(facets.languages.length).toBeGreaterThan(0);
    expect(facets.currencies).toContain("USD");
    expect((await listSetSummaries(db)).total).toBeGreaterThan(0);
    expect((await listIndexSummaries(db)).length).toBeGreaterThan(0);

    const printingId = scoredFirst.rows[0]!.printingId;
    const sentiment = await getCardSentiment(db, printingId, "90d");
    expect(sentiment.basis).toBe("accuracy_weighted");
    const evidence = await listCardEvidence(db, printingId);
    expect(evidence.items.length).toBeLessThanOrEqual(10);
  });
  it("keeps tcg_score_latest equal to the newest snapshot per printing", async () => {
    const admin = adminConn!.db;
    const mismatch = await admin.execute(sql`
      WITH derived AS (
        SELECT DISTINCT ON (ss.printing_id) ss.printing_id, ss.id FROM tcg_score_snapshot ss
        ORDER BY ss.printing_id, ss.as_of DESC, ss.created_at DESC, ss.id DESC
      )
      SELECT count(*)::int AS n FROM derived d
      FULL JOIN tcg_score_latest l ON l.printing_id = d.printing_id
      WHERE l.id IS DISTINCT FROM d.id`);
    const rows = (Array.isArray(mismatch) ? mismatch : (mismatch as { rows: unknown[] }).rows) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
    const [count] = (await admin.execute(sql`SELECT count(*)::int AS n FROM tcg_score_latest`)) as unknown as { n: number }[];
    expect(count!.n).toBeGreaterThan(0);
  });
  it("prices from tcg_price_latest exactly as from the full history", async () => {
    const db = appConn!.db;
    const [count] = (await adminConn!.db.execute(sql`SELECT count(*)::int AS n FROM tcg_price_latest`)) as unknown as { n: number }[];
    expect(count!.n).toBeGreaterThan(0);
    const priceOf = (page: Awaited<ReturnType<typeof listCardExplorerPage>>) =>
      page.rows.map((row) => [row.printingId, row.price?.amount ?? null, row.price?.quoteType ?? null, row.price?.observedAt.toISOString() ?? null]);
    for (const params of [
      { sort: "price_high", pageSize: "48" },
      { sort: "price_low", pageSize: "48" },
      { minPrice: "1", maxPrice: "100000", sort: "market_buy", pageSize: "48" },
    ]) {
      // Live reads use tcg_price_latest; a read "as of" a moment walks the history.
      const fast = await listCardExplorerPage(db, parseExplorerQuery(params));
      const slow = await listCardExplorerPage(db, parseExplorerQuery(params), { now: new Date() });
      expect(fast.total, JSON.stringify(params)).toBe(slow.total);
      expect(priceOf(fast), JSON.stringify(params)).toEqual(priceOf(slow));
    }
    const ranged = await listCardExplorerPage(db, parseExplorerQuery({ minPrice: "1", maxPrice: "100000" }));
    for (const row of ranged.rows) {
      expect(row.price?.currency).toBe("USD");
      expect(Number(row.price?.amount)).toBeGreaterThanOrEqual(1);
    }
    // A newer price inserted later moves the latest-price row through the trigger.
    const target = ranged.rows[0]!.printingId;
    const yesterday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1, 20));
    const before = ranged.rows[0]!.price!.observedAt;
    if (before < yesterday) {
      await adminConn!.db.execute(sql`
        INSERT INTO tcg_daily_price (printing_id, observed_at, market, low, mid, high, source)
        VALUES (${target}, ${yesterday.toISOString()}::timestamptz, 123.45, NULL, NULL, NULL, 'daily')
        ON CONFLICT DO NOTHING`);
      const after = await listCardExplorerPage(db, parseExplorerQuery({ q: ranged.rows[0]!.canonicalPrintingKey }));
      const row = after.rows.find((item) => item.printingId === target);
      expect(row?.price?.amount && Number(row.price.amount)).toBe(123.45);
    }
  });
  it("lists chase cards and most-talked-about cards", async () => {
    const db = appConn!.db;
    const chase = await listCardExplorerPage(db, parseExplorerQuery({ view: "chase", pageSize: "48" }));
    const all = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48" }));
    expect(chase.total).toBeLessThanOrEqual(all.total);
    const talked = await listCardExplorerPage(db, parseExplorerQuery({ view: "talked", sort: "social_posts", window: "90d", pageSize: "48" }));
    for (const row of talked.rows) expect(row.sentiment.classified + row.sentiment.unknown).toBeGreaterThanOrEqual(0);
    expect(talked.total).toBeLessThanOrEqual(all.total);
  });
  it("pages through ties exactly as one whole-catalog sort would", async () => {
    const db = appConn!.db;
    // One big tie: every card shares the same scores, so pages cut through the
    // tie and only the priced-first rule and printing id decide the order.
    // Score history is append-only, so the test lifts the guard for this one edit.
    await adminConn!.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE tcg_score_snapshot DISABLE TRIGGER USER`);
      await tx.execute(sql`UPDATE tcg_score_snapshot SET opportunity_score = 70, confidence_score = 50, risk_score = 40, liquidity_score = 50`);
      await tx.execute(sql`ALTER TABLE tcg_score_snapshot ENABLE TRIGGER USER`);
      // The latest-score copy (0043) follows inserts only, so mirror the edit there.
      await tx.execute(sql`UPDATE tcg_score_latest SET opportunity_score = 70, confidence_score = 50, risk_score = 40, liquidity_score = 50`);
    });
    const mixed = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48", window: "90d" }));
    expect(mixed.rows.some((row) => row.price)).toBe(true);
    expect(mixed.rows.some((row) => !row.price)).toBe(true);
    for (const sort of ["opportunity", "name", "risk_low", "market_buy", "recent", "confidence"]) {
      const whole = await listCardExplorerPage(db, parseExplorerQuery({ pageSize: "48", sort, window: "90d" }));
      expect(whole.total).toBeLessThanOrEqual(48);
      expect(whole.total).toBeGreaterThan(6);
      const paged: string[] = [];
      for (let page = 1; page <= whole.total + 1; page += 1) {
        const part = await listCardExplorerPage(db, { ...parseExplorerQuery({ page: String(page), sort, window: "90d" }), pageSize: 2 });
        expect(part.total).toBe(whole.total);
        if (part.rows.length === 0) break;
        paged.push(...part.rows.map((row) => row.printingId));
      }
      expect(paged, sort).toEqual(whole.rows.map((row) => row.printingId));
    }
  });
});
