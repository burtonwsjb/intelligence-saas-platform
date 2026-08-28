import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  ingestTcgMarketRecord,
  member,
  platformAdmins,
  readMigrationSql,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  tenant,
  user,
  type Database,
} from "../index.js";
import {
  STAGING_FIXTURE_PROVENANCE,
  assertStagingFixtureAllowed,
  collectStagingFixtureVerification,
  formatStagingFixtureReport,
  runStagingFixturePipeline,
  StagingFixtureError,
} from "./staging-fixture.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  return { db };
}

describe("staging fixture pipeline", () => {
  it("refuses production and does not call live providers", () => {
    expect(() =>
      assertStagingFixtureAllowed({ ISP_ENV: "production", NODE_ENV: "production" }),
    ).toThrow(StagingFixtureError);
    expect(() => assertStagingFixtureAllowed({ ISP_ENV: "staging", NODE_ENV: "production" })).not.toThrow();
    expect(() => assertStagingFixtureAllowed({ NODE_ENV: "test" })).not.toThrow();
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "staging-fixture.ts"), "utf8");
    const cli = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../staging-fixture.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(cli).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/TCC_API_TOKEN|STRIPE_SECRET|YOUTUBE|reddit\.com\/api/i);
    expect(cli).toMatch(/requirePlatformAdminConnectionUrl/);
    expect(cli).not.toMatch(/PLATFORM_ADMIN_EMAILS/);
  });

  it("loads the existing sandbox fixtures end to end without wiping tenants", async () => {
    const { db } = await setup();
    await db.insert(user).values({
      id: "user_tenant",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
    });
    await db.insert(platformAdmins).values({ userId: "user_tenant", note: "keep" });

    const first = await runStagingFixturePipeline(db);
    expect(first.printings).toBeGreaterThan(0);
    expect(first.creators).toBeGreaterThan(0);
    expect(first.creatorCalls).toBeGreaterThan(0);
    expect(first.marketSnapshots).toBeGreaterThan(0);
    expect(first.sourceMentions).toBeGreaterThan(0);
    expect(first.scores).toBeGreaterThan(0);
    expect(first.indexLevels).toBeGreaterThan(0);
    expect(first.predictions).toBeGreaterThan(0);
    expect(first.predictionsPublished).toBe(0);
    expect(first.marketQuarantine).toBe(0);
    expect(first.outboxFailed).toBe(0);
    expect(first.platformAdmins).toBe(1);
    expect(first.customers).toBe(0);

    const report = formatStagingFixtureReport(first);
    expect(report).toContain(`provenance: ${STAGING_FIXTURE_PROVENANCE}`);
    expect(report).not.toMatch(/postgresql:\/\//);
    expect(report).not.toContain("owner@example.com");

    const second = await runStagingFixturePipeline(db);
    expect(second).toEqual(first);

    const grants = await db.select().from(platformAdmins);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.note).toBe("keep");
    expect(await db.select().from(tenant)).toEqual([]);
    expect(await db.select().from(member)).toEqual([]);
  });

  it("resumes after a mid-run stop without duplicating fixture rows", async () => {
    const { db } = await setup();
    await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    const partial = await collectStagingFixtureVerification(db);
    expect(partial.marketSnapshots).toBeGreaterThan(0);
    expect(partial.scores).toBe(0);
    expect(partial.indexLevels).toBe(0);
    expect(partial.predictions).toBe(0);

    const first = await runStagingFixturePipeline(db);
    expect(first.marketSnapshots).toBe(partial.marketSnapshots);
    const second = await runStagingFixturePipeline(db);
    expect(second).toEqual(first);
    expect(second.customers).toBe(0);
  });

  it("keeps predictions in shadow and does not enqueue tenant outbox jobs", async () => {
    const { db } = await setup();
    await runStagingFixturePipeline(db);
    const counts = await collectStagingFixtureVerification(db);
    expect(counts.predictionsPublished).toBe(0);
    expect(counts.outboxFailed).toBe(0);
    expect(counts.predictions).toBe(5);
  });
});
