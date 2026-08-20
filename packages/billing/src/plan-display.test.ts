import { describe, expect, it } from "vitest";
import { PLAN_PRICE_DISPLAY } from "./plan-display.js";
import { RETENTION_POLICY, trialDurationDays } from "./policy.js";

describe("plan display and retention", () => {
  it("does not invent dollar prices and does not delete data on cancel", () => {
    expect(PLAN_PRICE_DISPLAY.starter.amountUsd).toBeNull();
    expect(PLAN_PRICE_DISPLAY.starter.label).toBe("TBD");
    expect(PLAN_PRICE_DISPLAY.growth.configured).toBe(false);
    expect(RETENTION_POLICY.deleteCustomerDataOnCancel).toBe(false);
    expect(RETENTION_POLICY.deleteCustomerDataOnPastDue).toBe(false);
    expect(trialDurationDays({})).toBe(14);
    expect(trialDurationDays({ TRIAL_DURATION_DAYS: "21" })).toBe(21);
  });
});
