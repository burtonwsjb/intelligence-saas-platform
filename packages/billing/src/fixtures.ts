import type { PlanKey } from "./entitlements.js";
import type { SubscriptionStatus } from "./subscription.js";

export type SimulatedSubscriptionFixture = {
  planKey: PlanKey;
  status: SubscriptionStatus;
};

/**
 * Normalized subscription fixtures for disposable local/test databases.
 * These are application states, not Stripe objects. Do not treat them as
 * provider IDs.
 */
export const LOCAL_BILLING_FIXTURES = {
  free: { planKey: "free", status: "none" },
  trialing: { planKey: "starter", status: "trialing" },
  active: { planKey: "starter", status: "active" },
  past_due: { planKey: "starter", status: "past_due" },
  canceled: { planKey: "starter", status: "canceled" },
} as const satisfies Record<string, SimulatedSubscriptionFixture>;

export type LocalBillingFixtureName = keyof typeof LOCAL_BILLING_FIXTURES;
