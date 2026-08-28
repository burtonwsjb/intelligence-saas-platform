import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  ingestTcgMarketRecord,
  qualifyIndexMembers,
  readMigrationSql,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  type Database,
} from "../index.js";
import { STAGING_FIXTURE_AS_OF } from "../platform/staging-fixture.js";
import { tcgMarketSnapshot } from "../schema/tcg-market.js";
import { MS_DAY } from "./catalog.js";

const asOf = new Date("2026-01-04T12:00:00.000Z");
const from = new Date(asOf.getTime() - 30 * MS_DAY);

function compileSalesCount(db: Database, lowerBound: ReturnType<typeof gt> | ReturnType<typeof sql>) {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(tcgMarketSnapshot)
    .where(
      and(
        eq(tcgMarketSnapshot.printingId, "prn_test"),
        eq(tcgMarketSnapshot.priceType, "sold"),
        eq(tcgMarketSnapshot.condition, "nm"),
        lte(tcgMarketSnapshot.observedAt, asOf),
        lowerBound,
        isNull(tcgMarketSnapshot.gradingCompany),
      ),
    )
    .toSQL();
}

/**
 * postgres.js 3.4.9 Bind (connection.js) coerces values whose OID is missing
 * from serializers with `'' + x`. That is Date#toString() (locale), which Neon
 * rejects as timestamptz input. Typed Drizzle comparators encode via
 * PgTimestamp.mapToDriverValue → Date#toISOString() first.
 */
function postgresJsBindFallback(value: unknown): string {
  return "" + (value as string);
}

describe("hosted postgres timestamp binding", () => {
  it("reproduces the Neon locale Date string from untyped sql interpolation", () => {
    const client = new PGlite();
    const db = drizzle(client) as unknown as Database;

    const unsafe = compileSalesCount(db, sql`${tcgMarketSnapshot.observedAt} > ${from}`);
    const safe = compileSalesCount(db, gt(tcgMarketSnapshot.observedAt, from));

    expect(asOf.toISOString()).toBe("2026-01-04T12:00:00.000Z");
    expect(from.toISOString()).toBe("2025-12-05T12:00:00.000Z");

    const localeBound = postgresJsBindFallback(from);
    expect(localeBound).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(localeBound).toMatch(/Dec|12/);

    const unsafeDates = unsafe.params.filter((param) => param instanceof Date);
    expect(unsafeDates).toHaveLength(1);
    expect(postgresJsBindFallback(unsafeDates[0])).toBe(localeBound);
    expect(unsafe.params).toContain("2026-01-04T12:00:00.000Z");

    expect(safe.params.filter((param) => param instanceof Date)).toEqual([]);
    expect(safe.params).toContain("2026-01-04T12:00:00.000Z");
    expect(safe.params).toContain("2025-12-05T12:00:00.000Z");
    expect(safe.params.map(postgresJsBindFallback).join("\n")).not.toContain(localeBound);
  });

  it("keeps UTC window semantics for index sales counts at the staging as-of", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    const members = await qualifyIndexMembers(db, "pokemon.language.en", STAGING_FIXTURE_AS_OF);
    expect(members.some((row) => row.printingId === seeded.printings.greninjaEnNormal.id)).toBe(true);
    expect(STAGING_FIXTURE_AS_OF.toISOString()).toBe("2026-01-04T12:00:00.000Z");
  });

  it("does not interpolate Date values into raw sql templates in market/scoring paths", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      path.join(root, "features.ts"),
      path.join(root, "index-engine.ts"),
      path.join(root, "benchmark.ts"),
      path.join(root, "alpha.ts"),
      path.join(root, "../scoring/gather.ts"),
      path.join(root, "../scoring/persist.ts"),
      path.join(root, "../tcg/market-query.ts"),
      path.join(root, "../tcg/market-ingest.ts"),
      path.join(root, "../prediction/issue.ts"),
      path.join(root, "../prediction/evaluate.ts"),
      path.join(root, "../platform/staging-fixture.ts"),
      path.join(root, "../creator/outcomes.ts"),
      path.join(root, "../creator/price-at-call.ts"),
    ];
    const dateSql = /sql`[^`]*\$\{(?:from|to|asOf|cutoff|endAt|issuedAt|publishedAt|from7|from14)\}/;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(dateSql);
    }
    const indexEngine = readFileSync(path.join(root, "index-engine.ts"), "utf8");
    expect(indexEngine).toContain("gt(tcgMarketSnapshot.observedAt, from)");
    expect(indexEngine).not.toContain("sql`${tcgMarketSnapshot.observedAt} > ${from}`");
  });
});
