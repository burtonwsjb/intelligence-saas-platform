import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  checkPlatformAdminAccess,
  hasPlatformAdminGrant,
  member,
  organization,
  platformAdmins,
  readMigrationSql,
  tenant,
  user,
  type Database,
} from "../index.js";
import {
  PlatformAdminGrantError,
  formatGrantPlatformAdminReport,
  grantPlatformAdminByEmail,
  parseGrantPlatformAdminArgs,
  sanitizePlatformAdminCliMessage,
} from "./grant-by-email.js";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

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
    id: "user_pending",
    name: "Pending",
    email: "pending@example.com",
    emailVerified: false,
  });
  await db.insert(organization).values({
    id: "org_a",
    name: "Social Signal IQ",
    slug: "social-signal-iq",
  });
  await db.insert(member).values({
    id: "mem_a",
    organizationId: "org_a",
    userId: "user_op",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_a",
    status: "active",
    createdByUserId: "user_op",
  });
  return { db };
}

describe("grant platform admin by email", () => {
  it("grants a verified Better Auth user without changing tenant ownership", async () => {
    const { db } = await setup();
    const membersBefore = await db.select().from(member).where(eq(member.userId, "user_op"));
    const [tenantBefore] = await db.select().from(tenant);

    const result = await grantPlatformAdminByEmail(db, {
      email: "  Operator@Example.com ",
    });

    expect(result).toEqual({
      status: "granted",
      userId: "user_op",
      emailVerified: true,
    });
    expect(await hasPlatformAdminGrant(db, "user_op")).toBe(true);
    expect(await checkPlatformAdminAccess(db, { userId: "user_op", email: "operator@example.com" })).toEqual({
      granted: true,
      source: "table",
    });
    const membersAfter = await db.select().from(member).where(eq(member.userId, "user_op"));
    expect(membersAfter).toEqual(membersBefore);
    const [memberRow] = await db.select().from(member).where(eq(member.userId, "user_op"));
    expect(memberRow?.role).toBe("owner");
    const [tenantAfter] = await db.select().from(tenant);
    expect(tenantAfter).toEqual(tenantBefore);
    expect(formatGrantPlatformAdminReport(result)).toBe(
      ["status: granted", "user_id: user_op", "email_verified: true"].join("\n"),
    );
    expect(formatGrantPlatformAdminReport(result)).not.toContain("operator@example.com");
  });

  it("is idempotent and refuses missing or unverified users", async () => {
    const { db } = await setup();
    await grantPlatformAdminByEmail(db, { email: "operator@example.com" });
    const again = await grantPlatformAdminByEmail(db, { email: "operator@example.com" });
    expect(again.status).toBe("already_granted");
    expect(again.userId).toBe("user_op");
    const grants = await db.select().from(platformAdmins);
    expect(grants).toHaveLength(1);

    await expect(grantPlatformAdminByEmail(db, { email: "missing@example.com" })).rejects.toMatchObject({
      name: "PlatformAdminGrantError",
      code: "user_not_found",
    });
    await expect(grantPlatformAdminByEmail(db, { email: "pending@example.com" })).rejects.toMatchObject({
      name: "PlatformAdminGrantError",
      code: "email_unverified",
    });
    expect(await hasPlatformAdminGrant(db, "user_pending")).toBe(false);
  });

  it("parses CLI email arguments and never prints secrets", () => {
    expect(parseGrantPlatformAdminArgs(["--email", "Ops@Example.COM"])).toEqual({
      email: "ops@example.com",
      note: "cli.grant_platform_admin",
    });
    expect(parseGrantPlatformAdminArgs(["--", "ops@example.com"])).toEqual({
      email: "ops@example.com",
      note: "cli.grant_platform_admin",
    });
    expect(() => parseGrantPlatformAdminArgs([])).toThrow(PlatformAdminGrantError);
    expect(() => parseGrantPlatformAdminArgs(["--email"])).toThrow(/valid email/);
    const leaked = sanitizePlatformAdminCliMessage(
      "connect postgresql://app_admin:hunter2@db.example.internal/neondb password=hunter2 re_abc123",
    );
    expect(leaked).not.toContain("hunter2");
    expect(leaked).not.toContain("postgresql://");
    expect(leaked).not.toContain("re_abc123");
    expect(leaked).toContain("[redacted]");
  });

  it("does not use PLATFORM_ADMIN_EMAILS or mint a bypass", () => {
    const grantSource = readFileSync(path.join(sourceDir, "grant-by-email.ts"), "utf8");
    const cliSource = readFileSync(path.join(sourceDir, "../grant-platform-admin.ts"), "utf8");
    expect(grantSource).not.toMatch(/PLATFORM_ADMIN_EMAILS/);
    expect(cliSource).not.toMatch(/PLATFORM_ADMIN_EMAILS/);
    expect(cliSource).toMatch(/requirePlatformAdminConnectionUrl/);
    expect(cliSource).not.toMatch(/console\.(log|error|info).*process\.env/);
    expect(cliSource).not.toMatch(/DATABASE_ADMIN_URL\}/);
  });
});
