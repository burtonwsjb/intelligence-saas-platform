import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingDatabaseAdminUrlError,
  MissingDatabaseUrlError,
  requireDatabaseAdminUrl,
  requireDatabaseUrl,
} from "./env.js";
import { readMigrationSql } from "./migrations.js";
import {
  account,
  auditEvent,
  invitation,
  member,
  organization,
  session,
  tenant,
  tenantBilling,
  tenantResource,
  user,
  verification,
  apiKey,
  plan,
  usageEvent,
} from "./schema/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("database env", () => {
  it("fails clearly without DATABASE_URL", () => {
    expect(() => requireDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
    expect(() => requireDatabaseUrl({ DATABASE_URL: "   " })).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  it("fails clearly without DATABASE_ADMIN_URL", () => {
    expect(() => requireDatabaseAdminUrl({})).toThrow(MissingDatabaseAdminUrlError);
  });

  it("returns a configured DATABASE_URL", () => {
    expect(requireDatabaseUrl({ DATABASE_URL: "postgresql://isp@localhost/isp" })).toBe(
      "postgresql://isp@localhost/isp",
    );
  });
});

describe("schema ownership", () => {
  it("exports Better Auth-owned tables", () => {
    expect(user).toBeDefined();
    expect(session).toBeDefined();
    expect(account).toBeDefined();
    expect(verification).toBeDefined();
    expect(organization).toBeDefined();
    expect(member).toBeDefined();
    expect(invitation).toBeDefined();
  });

  it("exports application-owned tenant tables", () => {
    expect(tenant).toBeDefined();
    expect(auditEvent).toBeDefined();
    expect(tenantResource).toBeDefined();
  });

  it("exports billing and API key tables", () => {
    expect(plan).toBeDefined();
    expect(tenantBilling).toBeDefined();
    expect(apiKey).toBeDefined();
    expect(usageEvent).toBeDefined();
  });
});

describe("migrations", () => {
  it("includes active-tenant RLS and does not RLS Better Auth identity tables", async () => {
    const sql = await readMigrationSql();
    expect(sql).toMatch(/"issuer" text NOT NULL/);
    expect(sql).toMatch(/ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "tenant_resource" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/app.has_active_membership\(\)/);
    expect(sql).toMatch(/app.tenant_is_active\(\)/);
    expect(sql).toMatch(/CREATE POLICY tenant_select ON "tenant"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "api_key"/);
    expect(sql).toMatch(/app.has_machine_principal\(\)/);
    expect(sql).toMatch(/app.claim_stripe_event/);
    expect(sql).not.toMatch(/ALTER TABLE "user" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "session" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "member" ENABLE ROW LEVEL SECURITY/);
  });
});

describe("committed env example", () => {
  it("contains names only", () => {
    const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^BETTER_AUTH_SECRET=$/m);
    expect(example).toMatch(/^DATABASE_URL=$/m);
    expect(example).toMatch(/^DATABASE_ADMIN_URL=$/m);
    expect(example).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/);
  });
});
