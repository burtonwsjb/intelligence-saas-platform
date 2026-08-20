import { describe, expect, it } from "vitest";
import {
  EntitlementDeniedError,
  QuotaExceededError,
  assertFeature,
  assertWithinLimit,
  applyBetaSafetyCaps,
  effectivePlanKey,
  getLimit,
  hasFeature,
  resolveEntitlement,
} from "./entitlements.js";

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

describe("entitlement resolver", () => {
  it("uses plan defaults and tenant overrides", () => {
    const base = resolveEntitlement({
      planKey: "starter",
      status: "active",
      catalog,
      key: "api_keys",
    });
    expect(getLimit(base)).toBe(5);
    const overridden = resolveEntitlement({
      planKey: "starter",
      status: "active",
      catalog,
      overrides: [
        {
          planKey: "starter",
          entitlementKey: "api_keys",
          valueKind: "limit",
          enabled: true,
          limitValue: 9,
        },
      ],
      key: "api_keys",
    });
    expect(getLimit(overridden)).toBe(9);
  });

  it("fails closed for unknown keys and unpaid subscriptions", () => {
    const unknown = resolveEntitlement({
      planKey: "starter",
      status: "active",
      catalog,
      key: "not_a_real_entitlement",
    });
    expect(hasFeature(unknown)).toBe(false);
    expect(getLimit(unknown)).toBe(0);
    expect(effectivePlanKey("starter", "past_due")).toBe("free");
    expect(effectivePlanKey("starter", "unpaid")).toBe("free");
    expect(effectivePlanKey("starter", "canceled")).toBe("free");
    expect(() =>
      assertFeature(
        resolveEntitlement({
          planKey: "free",
          status: "none",
          catalog,
          key: "predictions",
        }),
      ),
    ).toThrow(EntitlementDeniedError);
    expect(() =>
      assertWithinLimit(
        resolveEntitlement({
          planKey: "free",
          status: "none",
          catalog,
          key: "api_keys",
        }),
        1,
      ),
    ).toThrow(QuotaExceededError);
  });

  it("applies conservative beta caps without raising limits", () => {
    const capped = applyBetaSafetyCaps(
      {
        key: "api_keys",
        kind: "limit",
        enabled: true,
        limit: 50,
      },
      { BETA_SAFETY_LIMITS: "true" },
    );
    expect(capped.limit).toBe(3);
    expect(
      applyBetaSafetyCaps(
        { key: "content_generation", kind: "boolean", enabled: true, limit: null },
        { ISP_ENV: "staging" },
      ).enabled,
    ).toBe(false);
  });
});
