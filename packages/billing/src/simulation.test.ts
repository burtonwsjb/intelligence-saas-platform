import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  getTenantBilling,
  member,
  organization,
  readMigrationSql,
  tenant,
  user,
  withOrganizationContext,
  type Database,
} from "@isp/db";
import { assertWithinLimit, getLimit, hasFeature, resolveEntitlement } from "./entitlements.js";
import { LOCAL_BILLING_FIXTURES } from "./fixtures.js";
import { ProductionBillingSimulationError } from "./mode.js";
import { loadEntitlement } from "./resolver.js";
import {
  SimulatedBillingIsolationError,
  simulateTenantEntitlementOverride,
  simulateTenantSubscription,
} from "./simulation.js";

const catalog = [
  {
    planKey: "free",
    entitlementKey: "api_keys",
    valueKind: "limit",
    enabled: true,
    limitValue: 1,
  },
  {
    planKey: "starter",
    entitlementKey: "api_keys",
    valueKind: "limit",
    enabled: true,
    limitValue: 5,
  },
  {
    planKey: "free",
    entitlementKey: "predictions",
    valueKind: "boolean",
    enabled: false,
    limitValue: null,
  },
  {
    planKey: "starter",
    entitlementKey: "predictions",
    valueKind: "boolean",
    enabled: true,
    limitValue: null,
  },
  {
    planKey: "free",
    entitlementKey: "api_requests_per_month",
    valueKind: "limit",
    enabled: true,
    limitValue: 1000,
  },
  {
    planKey: "starter",
    entitlementKey: "api_requests_per_month",
    valueKind: "limit",
    enabled: true,
    limitValue: 25000,
  },
];

function entitlementFor(
  fixture: (typeof LOCAL_BILLING_FIXTURES)[keyof typeof LOCAL_BILLING_FIXTURES],
  key: string,
  overrides?: Parameters<typeof resolveEntitlement>[0]["overrides"],
) {
  return resolveEntitlement({
    planKey: fixture.planKey,
    status: fixture.status,
    catalog,
    overrides,
    key,
  });
}

describe("local billing simulation fixtures", () => {
  it("resolves free, trialing, active, past_due, and canceled like Stripe-normalized state", () => {
    expect(hasFeature(entitlementFor(LOCAL_BILLING_FIXTURES.free, "predictions"))).toBe(false);
    expect(getLimit(entitlementFor(LOCAL_BILLING_FIXTURES.free, "api_keys"))).toBe(1);
    expect(hasFeature(entitlementFor(LOCAL_BILLING_FIXTURES.trialing, "predictions"))).toBe(true);
    expect(getLimit(entitlementFor(LOCAL_BILLING_FIXTURES.trialing, "api_keys"))).toBe(5);
    expect(hasFeature(entitlementFor(LOCAL_BILLING_FIXTURES.active, "predictions"))).toBe(true);
    expect(getLimit(entitlementFor(LOCAL_BILLING_FIXTURES.active, "api_keys"))).toBe(5);
    expect(hasFeature(entitlementFor(LOCAL_BILLING_FIXTURES.past_due, "predictions"))).toBe(false);
    expect(getLimit(entitlementFor(LOCAL_BILLING_FIXTURES.past_due, "api_keys"))).toBe(1);
    expect(hasFeature(entitlementFor(LOCAL_BILLING_FIXTURES.canceled, "predictions"))).toBe(false);
    expect(getLimit(entitlementFor(LOCAL_BILLING_FIXTURES.canceled, "api_keys"))).toBe(1);
  });

  it("applies overrides and enforces plan limits including API keys", () => {
    const overridden = entitlementFor(LOCAL_BILLING_FIXTURES.active, "api_keys", [
      {
        planKey: "starter",
        entitlementKey: "api_keys",
        valueKind: "limit",
        enabled: true,
        limitValue: 2,
      },
    ]);
    expect(getLimit(overridden)).toBe(2);
    expect(() => assertWithinLimit(overridden, 2)).toThrow(/quota/i);
    expect(() =>
      assertWithinLimit(entitlementFor(LOCAL_BILLING_FIXTURES.free, "api_keys"), 1),
    ).toThrow(/quota/i);
    expect(() =>
      assertWithinLimit(entitlementFor(LOCAL_BILLING_FIXTURES.active, "api_keys"), 1),
    ).not.toThrow();
    expect(() =>
      assertWithinLimit(entitlementFor(LOCAL_BILLING_FIXTURES.past_due, "api_keys"), 1),
    ).toThrow(/quota/i);
  });
});

describe("simulateTenantSubscription", () => {
  it("is unavailable in production", async () => {
    const db = {
      execute: async () => [{ organization_id: "org_a" }],
    } as unknown as Database;
    await expect(
      simulateTenantSubscription(db, {
        organizationId: "org_a",
        fixture: "active",
        env: { NODE_ENV: "production" },
      }),
    ).rejects.toThrow(ProductionBillingSimulationError);
  });

  it("rejects a simulated write for a foreign tenant context", async () => {
    const db = {
      execute: async () => [{ organization_id: "org_a" }],
    } as unknown as Database;
    await expect(
      simulateTenantSubscription(db, {
        organizationId: "org_b",
        fixture: "active",
        env: { NODE_ENV: "test" },
      }),
    ).rejects.toThrow(SimulatedBillingIsolationError);
  });
});

describe("local simulation against a disposable database", () => {
  it("writes normalized state and resolves entitlements without Stripe", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await db.insert(user).values({
      id: "user_sim",
      name: "Sim",
      email: "sim@example.com",
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: "org_sim",
      name: "Sim Org",
      slug: "org-sim",
    });
    await db.insert(member).values({
      id: "mem_sim",
      organizationId: "org_sim",
      userId: "user_sim",
      role: "owner",
    });
    await db.insert(tenant).values({
      organizationId: "org_sim",
      status: "active",
      createdByUserId: "user_sim",
    });

    await withOrganizationContext(
      db,
      { organizationId: "org_sim", userId: "user_sim" },
      async (scoped) => {
        await simulateTenantSubscription(scoped, {
          organizationId: "org_sim",
          fixture: "active",
          env: { NODE_ENV: "test" },
        });
        const billing = await getTenantBilling(scoped, "org_sim");
        expect(billing?.stripeCustomerId).toBeNull();
        expect(billing?.stripeSubscriptionId).toBeNull();
        expect(billing?.planKey).toBe("starter");
        expect(billing?.status).toBe("active");
        const predictions = await loadEntitlement(scoped, "org_sim", "predictions");
        expect(hasFeature(predictions)).toBe(true);
        expect(getLimit(await loadEntitlement(scoped, "org_sim", "api_keys"))).toBe(5);

        await simulateTenantSubscription(scoped, {
          organizationId: "org_sim",
          fixture: "trialing",
          env: { NODE_ENV: "test" },
        });
        const trial = await getTenantBilling(scoped, "org_sim");
        expect(trial?.status).toBe("trialing");
        expect(trial?.trialStartedAt).toBeTruthy();
        expect(trial?.trialEndsAt).toBeTruthy();
        expect(hasFeature(await loadEntitlement(scoped, "org_sim", "predictions"))).toBe(true);

        await simulateTenantSubscription(scoped, {
          organizationId: "org_sim",
          fixture: "past_due",
          env: { NODE_ENV: "test" },
        });
        expect(hasFeature(await loadEntitlement(scoped, "org_sim", "predictions"))).toBe(false);
        expect(getLimit(await loadEntitlement(scoped, "org_sim", "api_keys"))).toBe(1);

        await simulateTenantEntitlementOverride(scoped, {
          organizationId: "org_sim",
          entitlementKey: "api_keys",
          valueKind: "limit",
          enabled: true,
          limitValue: 3,
          env: { NODE_ENV: "test" },
        });
        expect(getLimit(await loadEntitlement(scoped, "org_sim", "api_keys"))).toBe(3);
      },
    );
  });
});
