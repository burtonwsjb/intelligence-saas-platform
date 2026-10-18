import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
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
    expect((await listSetSummaries(db)).total).toBeGreaterThan(0);
    expect((await listIndexSummaries(db)).length).toBeGreaterThan(0);

    const printingId = scoredFirst.rows[0]!.printingId;
    const sentiment = await getCardSentiment(db, printingId, "90d");
    expect(sentiment.basis).toBe("accuracy_weighted");
    const evidence = await listCardEvidence(db, printingId);
    expect(evidence.items.length).toBeLessThanOrEqual(10);
  });
});
