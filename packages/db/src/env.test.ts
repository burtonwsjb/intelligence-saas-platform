import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingDatabaseUrlError,
  requireDatabaseUrl,
} from "./env.js";
import { readMigrationSql } from "./migrations.js";
import { account, invitation, member, organization, session, tenant, user, verification } from "./schema/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("database env", () => {
  it("fails clearly without DATABASE_URL", () => {
    expect(() => requireDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
    expect(() => requireDatabaseUrl({ DATABASE_URL: "   " })).toThrow(
      /DATABASE_URL is not set/,
    );
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

  it("exports application-owned tenant table", () => {
    expect(tenant).toBeDefined();
  });
});

describe("migrations", () => {
  it("includes RLS on tenant and not on Better Auth user", async () => {
    const sql = await readMigrationSql();
    expect(sql).toMatch(/"issuer" text NOT NULL/);
    expect(sql).toMatch(/ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY tenant_isolation ON "tenant"/);
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
    expect(example).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/);
  });
});
