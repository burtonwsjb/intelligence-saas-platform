import { describe, expect, it } from "vitest";
import { effectivePlanKey, hasFeature, resolveEntitlement } from "./entitlements.js";
import { PAST_DUE_GRACE_DAYS } from "./policy.js";
import {
  billingPatchFromStripeEvent,
  shouldApplyStripeEvent,
  stripeCreatedFromAuditMetadata,
} from "./stripe-order.js";

const catalog = [
  {
    planKey: "starter",
    entitlementKey: "predictions",
    valueKind: "boolean",
    enabled: true,
    limitValue: null,
  },
  {
    planKey: "free",
    entitlementKey: "predictions",
    valueKind: "boolean",
    enabled: false,
    limitValue: null,
  },
];

describe("stripe event order", () => {
  it("applies the first event and equal timestamps, and ignores older events", () => {
    expect(shouldApplyStripeEvent({ lastAppliedCreated: null, incomingCreated: 100 })).toBe(true);
    expect(shouldApplyStripeEvent({ lastAppliedCreated: 100, incomingCreated: 100 })).toBe(true);
    expect(shouldApplyStripeEvent({ lastAppliedCreated: 100, incomingCreated: 101 })).toBe(true);
    expect(shouldApplyStripeEvent({ lastAppliedCreated: 101, incomingCreated: 100 })).toBe(false);
  });

  it("reads stripe_created from audit metadata only when numeric", () => {
    expect(stripeCreatedFromAuditMetadata({ stripe_created: 44 })).toBe(44);
    expect(stripeCreatedFromAuditMetadata({ stripe_created: "44" })).toBeNull();
    expect(stripeCreatedFromAuditMetadata(null)).toBeNull();
  });
});

describe("stripe billing patch", () => {
  it("records past_due since and grace without granting paid access during grace", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const patch = billingPatchFromStripeEvent({
      eventType: "invoice.payment_failed",
      status: "past_due",
      planKey: "starter",
      now,
      existing: {},
    });
    expect(patch.status).toBe("past_due");
    expect(patch.pastDueSince?.toISOString()).toBe(now.toISOString());
    expect(patch.graceEndsAt?.getTime()).toBe(now.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000);
    expect(effectivePlanKey(patch.planKey, patch.status)).toBe("free");
    expect(
      hasFeature(
        resolveEntitlement({
          planKey: patch.planKey,
          status: patch.status,
          catalog,
          key: "predictions",
        }),
      ),
    ).toBe(false);
  });

  it("keeps the original past_due window when a later failed invoice arrives", () => {
    const first = new Date("2026-09-01T00:00:00.000Z");
    const later = new Date("2026-09-03T00:00:00.000Z");
    const patch = billingPatchFromStripeEvent({
      eventType: "invoice.payment_failed",
      status: "past_due",
      planKey: "starter",
      now: later,
      existing: { pastDueSince: first, graceEndsAt: new Date("2026-09-08T00:00:00.000Z") },
    });
    expect(patch.pastDueSince?.toISOString()).toBe(first.toISOString());
    expect(patch.graceEndsAt?.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  it("clears past_due fields when the subscription is paid again", () => {
    const patch = billingPatchFromStripeEvent({
      eventType: "invoice.paid",
      status: "active",
      planKey: "starter",
      existing: {
        pastDueSince: new Date("2026-09-01T00:00:00.000Z"),
        graceEndsAt: new Date("2026-09-08T00:00:00.000Z"),
      },
    });
    expect(patch.status).toBe("active");
    expect(patch.pastDueSince).toBeNull();
    expect(patch.graceEndsAt).toBeNull();
    expect(effectivePlanKey(patch.planKey, patch.status)).toBe("starter");
  });

  it("cancels to free and does not revive from a stale active patch", () => {
    const deleted = billingPatchFromStripeEvent({
      eventType: "customer.subscription.deleted",
      status: "active",
      planKey: "starter",
      now: new Date("2026-09-02T00:00:00.000Z"),
      existing: {},
    });
    expect(deleted.status).toBe("canceled");
    expect(deleted.planKey).toBe("free");
    expect(shouldApplyStripeEvent({ lastAppliedCreated: 200, incomingCreated: 150 })).toBe(false);
  });
});
