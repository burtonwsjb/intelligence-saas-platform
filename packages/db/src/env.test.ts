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
  sourceEvent,
  outboxJob,
  entity,
  observation,
  signal,
  featureSnapshot,
  decisionRecord,
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
    expect(sourceEvent).toBeDefined();
    expect(outboxJob).toBeDefined();
    expect(entity).toBeDefined();
    expect(observation).toBeDefined();
    expect(signal).toBeDefined();
    expect(featureSnapshot).toBeDefined();
    expect(decisionRecord).toBeDefined();
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
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "source_event"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "outbox_job"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "entity"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "observation"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "signal"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "feature_snapshot"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "decision_record"/);
    expect(sql).toMatch(/app.install_kernel_rls\('entity'/);
    expect(sql).toMatch(/Analytical history is immutable/);
    expect(sql).not.toMatch(/ALTER TABLE "user" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "session" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "member" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tcg_game"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tcg_printing"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tcg_market_snapshot"/);
    expect(sql).toMatch(/app.forbid_tcg_canonical_mutate/);
    expect(sql).toMatch(/app.forbid_tcg_market_mutate/);
    expect(sql).not.toMatch(/ALTER TABLE "tcg_game" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "tcg_printing" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "tcg_market_snapshot" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "source_content"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "source_mention"/);
    expect(sql).not.toMatch(/ALTER TABLE "source_content" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "entity_resolution_attempt"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tcg_card_name_alias"/);
    expect(sql).not.toMatch(/ALTER TABLE "entity_resolution_attempt" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "creator_call"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "creator_authority_slice"/);
    expect(sql).not.toMatch(/ALTER TABLE "creator_call" ENABLE ROW LEVEL SECURITY/);
  });

  it("does not add TCG identity columns to generic kernel tables", async () => {
    const sql = await readMigrationSql();
    const entityCreate = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "entity"'), sql.indexOf('CREATE TABLE IF NOT EXISTS "entity_identifier"'));
    expect(entityCreate).not.toMatch(/collector_number/);
    expect(entityCreate).not.toMatch(/language_code/);
    expect(entityCreate).not.toMatch(/variant_key/);
    expect(entityCreate).not.toMatch(/card_name/);
  });
});

describe("committed env example", () => {
  it("contains names only", () => {
    const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^BETTER_AUTH_SECRET=$/m);
    expect(example).toMatch(/^DATABASE_URL=$/m);
    expect(example).toMatch(/^DATABASE_ADMIN_URL=$/m);
    expect(example).toMatch(/^REDIS_URL=$/m);
    expect(example).toMatch(/^QUEUE_PREFIX=$/m);
    expect(example).toMatch(/^TCC_API_BASE_URL=$/m);
    expect(example).toMatch(/^TCC_API_TOKEN=$/m);
    expect(example).not.toMatch(/tcgcardcentral\.com/i);
    expect(example).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/);
  });
});
