import { describe, expect, it } from "vitest";
import { alertRuleMatches, canDispatchPredictionAlert } from "./dispatch.js";

const entitled = { alerts: true, predictions: true };

describe("alert dispatch gates", () => {
  it("never fires prediction alerts without both alerts and predictions entitlements", () => {
    expect(canDispatchPredictionAlert({ alerts: true, predictions: false })).toBe(false);
    expect(canDispatchPredictionAlert({ alerts: false, predictions: true })).toBe(false);
    expect(
      alertRuleMatches({
        ruleType: "prediction_created",
        enabled: true,
        config: {},
        snapshot: { predictionCreated: true },
        entitlements: { alerts: true, predictions: false },
      }),
    ).toBe(false);
    expect(
      alertRuleMatches({
        ruleType: "prediction_created",
        enabled: true,
        config: {},
        snapshot: { predictionCreated: true },
        entitlements: entitled,
      }),
    ).toBe(true);
  });

  it("matches opportunity, price, creator, usage, and webhook rules and ignores disabled rules", () => {
    expect(
      alertRuleMatches({
        ruleType: "opportunity_score_threshold",
        enabled: true,
        config: { threshold: 70 },
        snapshot: { opportunityScore: 71 },
        entitlements: entitled,
      }),
    ).toBe(true);
    expect(
      alertRuleMatches({
        ruleType: "price_move",
        enabled: true,
        config: { percent: 10 },
        snapshot: { priceMovePercent: -12 },
        entitlements: entitled,
      }),
    ).toBe(true);
    expect(
      alertRuleMatches({
        ruleType: "creator_call",
        enabled: false,
        config: {},
        snapshot: { creatorCallDetected: true },
        entitlements: entitled,
      }),
    ).toBe(false);
    expect(
      alertRuleMatches({
        ruleType: "usage_threshold",
        enabled: true,
        config: { percent: 80 },
        snapshot: { usagePercent: 80 },
        entitlements: { alerts: false, predictions: false },
      }),
    ).toBe(false);
  });
});
