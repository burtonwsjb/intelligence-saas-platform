import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { generateApiKeySecret } from "@isp/auth";
import {
  enqueueWebhookDelivery,
  getMonthUsage,
  ingestTcgMarketRecord,
  insertApiKey,
  member,
  organization,
  readMigrationSql,
  scoreAndPersist,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  tenant,
  tenantBilling,
  upsertTenantEntitlementOverride,
  user,
  webhookSignatureValid,
  withMachineContext,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { createApiApp } from "./app.js";
import { commercialOpenApi } from "./openapi.js";

const pepper = "phase16-test-pepper-value";

async function seedTenant(
  db: Database,
  input: { orgId: string; userId: string; scopes: string; expiresAt?: Date },
) {
  const generated = generateApiKeySecret(pepper);
  await db.insert(user).values({
    id: input.userId,
    name: "User",
    email: `${input.userId}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({ id: input.orgId, name: input.orgId, slug: input.orgId });
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
  await withOrganizationContext(db, { organizationId: input.orgId, userId: input.userId }, (scoped) =>
    insertApiKey(scoped, {
      id: `key_${input.orgId}`,
      organizationId: input.orgId,
      name: "test",
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: input.scopes,
      createdByUserId: input.userId,
      expiresAt: input.expiresAt,
    }),
  );
  return generated.fullKey;
}

describe("commercial API and webhooks", () => {
  it("enforces auth, scopes, entitlements, identity, pagination, SSRF, and metering", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    for (const record of tcgMarketFixtureRecords()) {
      await ingestTcgMarketRecord(db, record);
    }
    await scoreAndPersist(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      asOf: new Date("2026-01-04T00:00:00.000Z"),
    });

    const scopes =
      "cards:read,prices:read,markets:read,signals:read,creators:read,predictions:read,opportunities:read,webhooks:manage";
    const key = await seedTenant(db, { orgId: "org_com", userId: "user_com", scopes });
    const otherKey = await seedTenant(db, {
      orgId: "org_other",
      userId: "user_other",
      scopes: "cards:read",
    });
    const expiredKey = await seedTenant(db, {
      orgId: "org_exp",
      userId: "user_exp",
      scopes,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const revokedKey = await seedTenant(db, {
      orgId: "org_rev",
      userId: "user_rev",
      scopes,
    });
    await client.exec(`update api_key set status = 'revoked', revoked_at = now() where id = 'key_org_rev'`);

    await withOrganizationContext(db, { organizationId: "org_com", userId: "user_com" }, async (scoped) => {
      await upsertTenantEntitlementOverride(scoped, {
        organizationId: "org_com",
        entitlementKey: "history_depth_days",
        valueKind: "limit",
        enabled: true,
        limitValue: 3650,
      });
      await upsertTenantEntitlementOverride(scoped, {
        organizationId: "org_com",
        entitlementKey: "webhooks",
        valueKind: "boolean",
        enabled: true,
        limitValue: null,
      });
      await upsertTenantEntitlementOverride(scoped, {
        organizationId: "org_com",
        entitlementKey: "predictions",
        valueKind: "boolean",
        enabled: true,
        limitValue: null,
      });
    });

    const deliveries: { url: string; body: string; headers: Record<string, string> }[] = [];
    const app = createApiApp({
      db,
      env: { API_KEY_PEPPER: pepper, NODE_ENV: "test" },
      webhookFetch: async (input) => {
        deliveries.push(input);
        return { status: 200, bodyText: "ok" };
      },
      dnsLookup: async () => ["93.184.216.34"],
    });

    const auth = { authorization: `Bearer ${key}` };
    const openapi = await app.request("/v1/openapi.json");
    expect(openapi.status).toBe(200);
    await expect(openapi.json()).resolves.toMatchObject({ openapi: "3.1.0" });
    expect(commercialOpenApi().paths["/v1/printings/{id}/opportunity"]).toBeTruthy();

    expect((await app.request("/v1/printings")).status).toBe(401);
    expect(
      (await app.request("/v1/printings", { headers: { authorization: `Bearer ${expiredKey}` } })).status,
    ).toBe(401);
    expect(
      (await app.request("/v1/printings", { headers: { authorization: `Bearer ${revokedKey}` } })).status,
    ).toBe(401);
    expect((await app.request("/v1/printings/:id/prices".replace(":id", "x"), { headers: { authorization: `Bearer ${otherKey}` } })).status).toBe(403);

    const badFilter = await app.request("/v1/printings?drop=1", { headers: auth });
    expect(badFilter.status).toBe(400);

    const printings = await app.request("/v1/printings?language=en&limit=1", {
      headers: { ...auth, "x-request-id": "req_print_1" },
    });
    expect(printings.status).toBe(200);
    const page = (await printings.json()) as { data: { language: string; variant: string; collector_number: string }[]; next_cursor: string | null };
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.language).toBe("en");
    expect(page.next_cursor).toBeTruthy();
    const ja = await app.request("/v1/printings?language=ja", { headers: auth });
    const jaBody = (await ja.json()) as { data: { language: string }[] };
    expect(jaBody.data.every((row) => row.language === "ja")).toBe(true);
    expect(jaBody.data.some((row) => row.language === "en")).toBe(false);

    const printingId = seeded.printings.greninjaEnNormal.id;
    const identity = await app.request(`/v1/printings/${printingId}`, { headers: auth });
    const ident = (await identity.json()) as { game: string; language: string; variant: string; collector_number: string };
    expect(ident).toMatchObject({
      game: "pokemon",
      language: "en",
      variant: "normal",
      collector_number: "214/167",
    });

    const prices = await app.request(`/v1/printings/${printingId}/prices`, {
      headers: { ...auth, "x-request-id": "req_price_1" },
    });
    expect(prices.status).toBe(200);
    const replay = await app.request(`/v1/printings/${printingId}/prices`, {
      headers: { ...auth, "x-request-id": "req_price_1" },
    });
    expect(replay.status).toBe(200);
    const usage = await withMachineContext(db, { organizationId: "org_com", apiKeyId: "key_org_com" }, (scoped) =>
      getMonthUsage(scoped, { organizationId: "org_com", meterKey: "prices.read" }),
    );
    expect(usage).toBe(1);

    const history = await app.request(`/v1/printings/${printingId}/market-history`, { headers: auth });
    expect(history.status).toBe(200);

    const opportunity = await app.request(`/v1/printings/${printingId}/opportunity`, { headers: auth });
    expect(opportunity.status).toBe(200);
    const scored = (await opportunity.json()) as {
      opportunity: number;
      risk: number;
      confidence: number;
      liquidity: number;
      recommendation: string;
      explanation: unknown[];
    };
    expect(scored.opportunity).not.toBe(scored.risk);
    expect(scored.explanation.length).toBeGreaterThan(0);

    const pred = await app.request(`/v1/printings/${printingId}/predictions`, { headers: auth });
    expect(pred.status).toBe(404);
    await expect(pred.json()).resolves.toMatchObject({ error: { code: "prediction_not_published" } });

    const creatorsDenied = await app.request("/v1/creators", { headers: auth });
    expect(creatorsDenied.status).toBe(402);
    await withOrganizationContext(db, { organizationId: "org_com", userId: "user_com" }, (scoped) =>
      upsertTenantEntitlementOverride(scoped, {
        organizationId: "org_com",
        entitlementKey: "creator_analytics",
        valueKind: "boolean",
        enabled: true,
        limitValue: null,
      }),
    );
    expect((await app.request("/v1/creators", { headers: auth })).status).toBe(200);

    const ssrf = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/hook", event_types: ["usage.warning"] }),
    });
    expect(ssrf.status).toBe(400);
    const privateIp = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://10.1.1.1/hook", event_types: ["usage.warning"] }),
    });
    expect(privateIp.status).toBe(400);
    const loop6 = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://[::1]/hook", event_types: ["usage.warning"] }),
    });
    expect(loop6.status).toBe(400);
    const scheme = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com/hook", event_types: ["usage.warning"] }),
    });
    expect(scheme.status).toBe(400);

    const created = await app.request("/v1/webhooks", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hooks/isp", event_types: ["opportunity.changed"] }),
    });
    expect(created.status).toBe(201);
    const hook = (await created.json()) as { id: string; secret: string };
    expect(hook.secret.startsWith("whsec_")).toBe(true);

    const listed = await app.request("/v1/webhooks", { headers: { authorization: `Bearer ${otherKey}` } });
    expect(listed.status).toBe(403);

    await withMachineContext(db, { organizationId: "org_com", apiKeyId: "key_org_com" }, (scoped) =>
      enqueueWebhookDelivery(scoped, {
        organizationId: "org_com",
        endpointId: hook.id,
        eventId: "evt_opp_1",
        eventType: "opportunity.changed",
        payload: { printing_id: printingId },
      }),
    );
    const first = await withMachineContext(db, { organizationId: "org_com", apiKeyId: "key_org_com" }, (scoped) =>
      enqueueWebhookDelivery(scoped, {
        organizationId: "org_com",
        endpointId: hook.id,
        eventId: "evt_opp_1",
        eventType: "opportunity.changed",
        payload: { printing_id: printingId },
      }),
    );
    expect(first.eventId).toBe("evt_opp_1");
    const processed = await app.request("/v1/webhooks/deliveries/process", { method: "POST", headers: auth });
    expect(processed.status).toBe(200);
    expect(deliveries).toHaveLength(1);
    expect(
      webhookSignatureValid({
        secret: hook.secret,
        timestamp: deliveries[0]!.headers["x-isp-timestamp"]!,
        body: deliveries[0]!.body,
        signature: deliveries[0]!.headers["x-isp-signature"]!,
        now: new Date(Number(deliveries[0]!.headers["x-isp-timestamp"])),
      }),
    ).toBe(true);
    expect(deliveries[0]!.headers["x-isp-event-id"]).toBe("evt_opp_1");

    await withOrganizationContext(db, { organizationId: "org_com", userId: "user_com" }, (scoped) =>
      upsertTenantEntitlementOverride(scoped, {
        organizationId: "org_com",
        entitlementKey: "predictions",
        valueKind: "boolean",
        enabled: false,
        limitValue: null,
      }),
    );
    const predDenied = await app.request(`/v1/printings/${printingId}/predictions`, { headers: auth });
    expect(predDenied.status).toBe(402);

    const indices = await app.request("/v1/indices?language=en", { headers: auth });
    expect(indices.status).toBe(200);
  });
});
