import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { generateApiKeySecret } from "@isp/auth";
import {
  getMonthUsage,
  getSourceEvent,
  insertApiKey,
  member,
  organization,
  readMigrationSql,
  tenant,
  tenantBilling,
  upsertTenantEntitlementOverride,
  user,
  withMachineContext,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";
import { INGEST_MAX_BYTES } from "./ingest.js";

const pepper = "phase05-test-pepper-value";

async function seedTenant(
  db: Database,
  input: { orgId: string; userId: string; scopes: string },
) {
  const generated = generateApiKeySecret(pepper);
  await db.insert(user).values({
    id: input.userId,
    name: "User",
    email: `${input.userId}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: input.orgId,
    name: input.orgId,
    slug: input.orgId,
  });
  await db.insert(member).values({
    id: `mem_${input.orgId}`,
    organizationId: input.orgId,
    userId: input.userId,
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: input.orgId,
    status: "active",
    createdByUserId: input.userId,
  });
  await db.insert(tenantBilling).values({
    organizationId: input.orgId,
    planKey: "free",
    status: "none",
  });
  await withOrganizationContext(
    db,
    { organizationId: input.orgId, userId: input.userId },
    (scoped) =>
      insertApiKey(scoped, {
        id: `key_${input.orgId}`,
        organizationId: input.orgId,
        name: "test",
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        scopes: input.scopes,
        createdByUserId: input.userId,
      }),
  );
  return generated.fullKey;
}

function eventBody(overrides?: Record<string, unknown>) {
  return {
    event_type: "pricing.snapshot",
    occurred_at: "2026-08-16T00:00:00.000Z",
    idempotency_key: "src:price:sku_123:2026-08-16T00:00:00Z",
    entity: { type: "sku", external_id: "sku_123" },
    metrics: [{ key: "price.usd", value: 12.34, unit: "usd" }],
    payload: { source: "generic_http" },
    ...overrides,
  };
}

describe("POST /v1/events", () => {
  it("enforces auth, scope, tenant, quota, idempotency, and durability without Redis", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const writeKey = await seedTenant(db, {
      orgId: "org_ingest",
      userId: "user_ingest",
      scopes: "ingest:write",
    });
    const readKey = await seedTenant(db, {
      orgId: "org_read",
      userId: "user_read",
      scopes: "decisions:read",
    });
    const app = createApiApp({
      db,
      env: { API_KEY_PEPPER: pepper, NODE_ENV: "test" },
    });

    const missing = await app.request("/v1/events", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);

    const wrongScope = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${readKey}` },
      body: JSON.stringify(eventBody()),
    });
    expect(wrongScope.status).toBe(403);

    const first = await app.request("/v1/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${writeKey}`,
        "x-request-id": "req_phase05_ingest_1",
      },
      body: JSON.stringify(eventBody()),
    });
    expect(first.status).toBe(202);
    expect(first.headers.get("x-request-id")).toBe("req_phase05_ingest_1");
    const accepted = (await first.json()) as { event_id: string; accepted: boolean };
    expect(accepted.accepted).toBe(true);

    const replay = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(eventBody()),
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual(accepted);

    const conflict = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(eventBody({ payload: { source: "changed" } })),
    });
    expect(conflict.status).toBe(409);

    const usage = await withMachineContext(
      db,
      { organizationId: "org_ingest", apiKeyId: "key_org_ingest" },
      (scoped) => getMonthUsage(scoped, { organizationId: "org_ingest", meterKey: "ingest.events" }),
    );
    expect(usage).toBe(1);

    const stored = await withMachineContext(
      db,
      { organizationId: "org_ingest", apiKeyId: "key_org_ingest" },
      (scoped) => getSourceEvent(scoped, { organizationId: "org_ingest", id: accepted.event_id }),
    );
    expect(stored?.processingStatus).toBe("received");

    await withOrganizationContext(
      db,
      { organizationId: "org_ingest", userId: "user_ingest" },
      (scoped) =>
        upsertTenantEntitlementOverride(scoped, {
          organizationId: "org_ingest",
          entitlementKey: "api_requests_per_month",
          valueKind: "limit",
          enabled: false,
          limitValue: 0,
        }),
    );
    const denied = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(eventBody({ idempotency_key: "src:price:denied:2026-08-16T00:00:00Z" })),
    });
    expect(denied.status).toBe(402);

    await withOrganizationContext(
      db,
      { organizationId: "org_ingest", userId: "user_ingest" },
      (scoped) =>
        upsertTenantEntitlementOverride(scoped, {
          organizationId: "org_ingest",
          entitlementKey: "api_requests_per_month",
          valueKind: "limit",
          enabled: true,
          limitValue: 1,
        }),
    );
    const over = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(eventBody({ idempotency_key: "src:price:over:2026-08-16T00:00:00Z" })),
    });
    expect(over.status).toBe(429);

    const huge = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: "x".repeat(INGEST_MAX_BYTES + 8),
    });
    expect(huge.status).toBe(413);

    await client.exec(`update tenant set status = 'suspended' where organization_id = 'org_ingest'`);
    const inactive = await app.request("/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${writeKey}` },
      body: JSON.stringify(
        eventBody({ idempotency_key: "src:price:inactive:2026-08-16T00:00:00Z" }),
      ),
    });
    expect(inactive.status).toBe(403);
  });
});
