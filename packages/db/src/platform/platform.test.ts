import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  checkPlatformAdminAccess,
  describePlatformConfig,
  emailIsLocalPlatformAdmin,
  excludeCreatorKeepingHistory,
  extractCreatorCallsFromContent,
  grantPlatformAdmin,
  hasPlatformAdminGrant,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  inspectTenant,
  insertSupportCase,
  listBreakGlassAudit,
  listCallsByCreator,
  listPredictionsForOperator,
  member,
  organization,
  parsePlatformAdminEmails,
  platformBreakGlassAudit,
  readMigrationSql,
  resolvePlatformAdminConnectionUrl,
  sanitizeAuditMetadata,
  seedTcgIdentityFixtures,
  SupportCaseRejectedError,
  tcgMarketFixtureRecords,
  tenant,
  user,
  type Database,
} from "../index.js";
import { creatorCallSourceFixtures } from "../creator/fixtures.js";
import { PlatformAdminDbNotConfiguredError } from "./connection.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  await db.insert(user).values({
    id: "user_op",
    name: "Operator",
    email: "operator@example.com",
    emailVerified: true,
  });
  await db.insert(user).values({
    id: "user_tenant",
    name: "Tenant",
    email: "tenant@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: "org_a",
    name: "Org A",
    slug: "org-a",
  });
  await db.insert(member).values({
    id: "mem_a",
    organizationId: "org_a",
    userId: "user_tenant",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_a",
    status: "active",
    createdByUserId: "user_tenant",
  });
  return { db };
}

describe("platform admin grants and config", () => {
  it("treats platform admin as a table grant, not a tenant role", async () => {
    const { db } = await setup();
    expect(await hasPlatformAdminGrant(db, "user_tenant")).toBe(false);
    await grantPlatformAdmin(db, { userId: "user_op", note: "local" });
    expect(await hasPlatformAdminGrant(db, "user_op")).toBe(true);
    const denied = await checkPlatformAdminAccess(db, {
      userId: "user_tenant",
      email: "tenant@example.com",
    });
    expect(denied.granted).toBe(false);
    const allowed = await checkPlatformAdminAccess(db, { userId: "user_op", email: "operator@example.com" });
    expect(allowed).toEqual({ granted: true, source: "table" });
  });

  it("uses local email allowlist only outside production", () => {
    expect(parsePlatformAdminEmails({ PLATFORM_ADMIN_EMAILS: "ops@example.com, other@example.com" })).toEqual([
      "ops@example.com",
      "other@example.com",
    ]);
    expect(
      emailIsLocalPlatformAdmin("ops@example.com", {
        NODE_ENV: "development",
        PLATFORM_ADMIN_EMAILS: "ops@example.com",
      }),
    ).toBe(true);
    expect(
      emailIsLocalPlatformAdmin("ops@example.com", {
        NODE_ENV: "production",
        PLATFORM_ADMIN_EMAILS: "ops@example.com",
      }),
    ).toBe(false);
    expect(
      emailIsLocalPlatformAdmin("ops@example.com", {
        NODE_ENV: "development",
        ISP_ENV: "staging",
        PLATFORM_ADMIN_EMAILS: "ops@example.com",
      }),
    ).toBe(false);
  });

  it("fails closed for production admin DB without APP_ADMIN_PASSWORD", () => {
    expect(() =>
      resolvePlatformAdminConnectionUrl({
        NODE_ENV: "production",
        DATABASE_ADMIN_URL: "postgresql://isp@localhost/isp",
      }),
    ).toThrow(PlatformAdminDbNotConfiguredError);
    expect(() =>
      resolvePlatformAdminConnectionUrl({
        NODE_ENV: "development",
        ISP_ENV: "staging",
        DATABASE_ADMIN_URL: "postgresql://isp@localhost/isp",
      }),
    ).toThrow(PlatformAdminDbNotConfiguredError);
    expect(
      resolvePlatformAdminConnectionUrl({
        NODE_ENV: "development",
        DATABASE_ADMIN_URL: "postgresql://isp@localhost/isp",
      }),
    ).toBe("postgresql://isp@localhost/isp");
  });

  it("does not leak secrets in config or audit metadata", () => {
    const config = describePlatformConfig({
      NODE_ENV: "development",
      BILLING_MODE: "local",
      STRIPE_SECRET_KEY: "sk_test_not_for_display",
      RESEND_API_KEY: "re_not_for_display",
      DATABASE_URL: "postgresql://isp:secret@localhost/isp",
    });
    expect(JSON.stringify(config)).not.toContain("sk_test");
    expect(JSON.stringify(config)).not.toContain("re_not");
    expect(JSON.stringify(config)).not.toContain("secret@");
    expect(config.stripeConfigured).toBe(true);
    expect(config.resendConfigured).toBe(true);
    expect(sanitizeAuditMetadata({ token: "abc", reason: "spam", apiKey: "isp_test_abc" })).toEqual({
      reason: "spam",
    });
  });
});

describe("platform operations", () => {
  it("excludes a creator without deleting call history and writes break-glass audit", async () => {
    const { db } = await setup();
    await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    const ingested = await ingestSourceContentRecord(db, creatorCallSourceFixtures()[0]!);
    const [extracted] = await extractCreatorCallsFromContent(db, ingested.contentId!);
    const creatorId = extracted!.call!.creatorId;
    const before = await listCallsByCreator(db, creatorId);
    expect(before.length).toBeGreaterThan(0);
    const result = await excludeCreatorKeepingHistory(db, {
      creatorId,
      actorUserId: "user_op",
      reason: "spam network",
    });
    expect(result.trustState).toBe("excluded");
    expect(result.callCount).toBe(before.length);
    const after = await listCallsByCreator(db, creatorId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    const audit = await listBreakGlassAudit(db);
    expect(audit.some((row) => row.action === "creator.exclude" && row.targetId === creatorId)).toBe(true);
  });

  it("inspects a tenant with an audited break-glass row without impersonating the tenant user", async () => {
    const { db } = await setup();
    const inspected = await inspectTenant(db, { organizationId: "org_a", actorUserId: "user_op" });
    expect(inspected.profile).toBeNull();
    const audit = await listBreakGlassAudit(db);
    expect(audit.some((row) => row.action === "tenant.inspect" && row.organizationId === "org_a")).toBe(true);
  });

  it("rejects secrets in support cases and records operator cases privately", async () => {
    const { db } = await setup();
    await expect(
      insertSupportCase(db, {
        organizationId: "org_a",
        subject: "Help",
        body: "here is sk_live_abc123",
        createdByUserId: "user_op",
      }),
    ).rejects.toThrow(SupportCaseRejectedError);
    const row = await insertSupportCase(db, {
      organizationId: "org_a",
      subject: "Billing question",
      body: "Customer asked about trial length.",
      createdByUserId: "user_op",
    });
    expect(row.status).toBe("open");
  });

  it("previews shadow predictions only through the operator path", async () => {
    const { db } = await setup();
    const rows = await listPredictionsForOperator(db, "user_op");
    expect(rows).toEqual([]);
    const audit = await db.select().from(platformBreakGlassAudit);
    expect(audit.some((row) => row.action === "predictions.preview")).toBe(true);
  });
});
