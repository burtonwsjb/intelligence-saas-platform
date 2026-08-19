import { describe, expect, it } from "vitest";
import { LiveStripeForbiddenError, StripeNotConfiguredError } from "./stripe-env.js";
import { createCheckoutSession, createPortalSession } from "./checkout.js";
import {
  ProductionBillingSimulationError,
  isLocalBillingSimulationAllowed,
  requireLocalBillingSimulation,
  resolveBillingMode,
} from "./mode.js";
import type { Database } from "@isp/db";

const dummyDb = {} as Database;

describe("billing modes", () => {
  it("defaults non-production to local simulation and forbids live", () => {
    expect(resolveBillingMode({ NODE_ENV: "test" })).toBe("local_simulation");
    expect(resolveBillingMode({ NODE_ENV: "development" })).toBe("local_simulation");
    expect(resolveBillingMode({ NODE_ENV: "test", BILLING_MODE: "stripe_test" })).toBe(
      "stripe_test",
    );
    expect(resolveBillingMode({ NODE_ENV: "production" })).toBe("stripe_test");
    expect(() => resolveBillingMode({ BILLING_MODE: "stripe_live" })).toThrow(
      LiveStripeForbiddenError,
    );
    expect(() =>
      resolveBillingMode({ NODE_ENV: "production", BILLING_MODE: "local_simulation" }),
    ).toThrow(ProductionBillingSimulationError);
    expect(isLocalBillingSimulationAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(() => requireLocalBillingSimulation({ NODE_ENV: "production" })).toThrow(
      ProductionBillingSimulationError,
    );
  });

  it("keeps Checkout and Portal fail-closed in local simulation", async () => {
    await expect(
      createCheckoutSession(dummyDb, {
        organizationId: "org_a",
        actorUserId: "user_a",
        planKey: "starter",
        successUrl: "http://localhost/ok",
        cancelUrl: "http://localhost/cancel",
        tenantName: "Org A",
        env: {
          NODE_ENV: "test",
          STRIPE_SECRET_KEY: "sk_test_should_not_be_used",
          STRIPE_PRICE_STARTER: "price_should_not_be_used",
        },
      }),
    ).rejects.toThrow(StripeNotConfiguredError);
    await expect(
      createPortalSession(dummyDb, {
        organizationId: "org_a",
        actorUserId: "user_a",
        returnUrl: "http://localhost/billing",
        env: { NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_should_not_be_used" },
      }),
    ).rejects.toThrow(StripeNotConfiguredError);
  });
});
