import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createOperatorApiKey, revokeOperatorApiKey } from "@isp/auth";
import {
  ApiRequestLimitError,
  listApiAccessWorkspaces,
  listOperatorApiKeys,
  member,
  organization,
  readMigrationSql,
  setWorkspaceApiRequestLimit,
  tenant,
  tenantBilling,
  user,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";

const pepper = "operator-keys-test-pepper";

describe("operator-issued customer API keys", () => {
  it("issues, lists, limits and revokes a key for a customer workspace", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await db.insert(user).values([
      { id: "user_customer", name: "Customer", email: "customer@example.com", emailVerified: true },
      { id: "user_operator", name: "Operator", email: "operator@example.com", emailVerified: true },
    ]);
    await db.insert(organization).values({ id: "org_customer", name: "Acme Cards", slug: "acme-cards" });
    await db.insert(member).values({
      id: "mem_customer",
      organizationId: "org_customer",
      userId: "user_customer",
      role: "owner",
    });
    await db.insert(tenant).values({ organizationId: "org_customer", status: "active", createdByUserId: "user_customer" });
    await db.insert(tenantBilling).values({ organizationId: "org_customer", planKey: "free", status: "none" });

    const created = await createOperatorApiKey(db, {
      organizationId: "org_customer",
      actorUserId: "user_operator",
      name: "Acme price tracker",
      scopes: ["cards:read", "signals:read"],
      pepper,
    });
    expect(created.fullKey.startsWith(created.prefix)).toBe(true);

    const app = createApiApp({ db, env: { API_KEY_PEPPER: pepper, NODE_ENV: "test" } });
    const ok = await app.request("/v1/cards?q=char&limit=5", {
      headers: { authorization: `Bearer ${created.fullKey}` },
    });
    expect(ok.status).toBe(200);
    const shortQuery = await app.request("/v1/cards?q=c", {
      headers: { authorization: `Bearer ${created.fullKey}` },
    });
    expect(shortQuery.status).toBe(400);
    const noScope = await app.request("/v1/creators", {
      headers: { authorization: `Bearer ${created.fullKey}` },
    });
    expect(noScope.status).toBe(403);

    const keys = await listOperatorApiKeys(db);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      organizationName: "Acme Cards",
      name: "Acme price tracker",
      scopes: ["cards:read", "signals:read"],
      status: "active",
    });
    expect(keys[0]!.requestsThisMonth).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(keys)).not.toContain(created.fullKey);

    await setWorkspaceApiRequestLimit(db, { organizationId: "org_customer", actorUserId: "user_operator", limit: 50_000 });
    let workspaces = await listApiAccessWorkspaces(db);
    expect(workspaces.find((row) => row.organizationId === "org_customer")).toMatchObject({
      ownerEmail: "customer@example.com",
      activeKeys: 1,
      requestLimitOverride: 50_000,
    });
    await setWorkspaceApiRequestLimit(db, { organizationId: "org_customer", actorUserId: "user_operator", limit: null });
    workspaces = await listApiAccessWorkspaces(db);
    expect(workspaces.find((row) => row.organizationId === "org_customer")?.requestLimitOverride).toBeNull();
    await expect(
      setWorkspaceApiRequestLimit(db, { organizationId: "org_customer", actorUserId: "user_operator", limit: -1 }),
    ).rejects.toBeInstanceOf(ApiRequestLimitError);

    await revokeOperatorApiKey(db, {
      organizationId: "org_customer",
      actorUserId: "user_operator",
      apiKeyId: created.id,
    });
    const revoked = await app.request("/v1/cards", {
      headers: { authorization: `Bearer ${created.fullKey}` },
    });
    expect(revoked.status).toBe(401);
  }, 60_000);
});
