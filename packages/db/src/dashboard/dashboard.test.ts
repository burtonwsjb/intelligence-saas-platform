import { describe, expect, it } from "vitest";
import { customerPredictionsEnabled } from "./flags.js";
import { formatPrintingIdentity, publishedPredictionsForCustomer } from "./queries.js";
import { isPredictionsNavVisible, visibleAppNav } from "./nav.js";
import { sparklinePath } from "./sparkline.js";
import { assertCanManageTeam, assertNotLastOwner, canAssignOwnerRole, isInvitableRole } from "./team.js";

describe("printing identity", () => {
  it("never omits language or variant", () => {
    expect(
      formatPrintingIdentity({
        printingId: "prn_1",
        gameKey: "pokemon",
        cardName: "Pikachu",
        setName: "Base Set",
        setKey: "base",
        collectorNumber: "25",
        languageCode: "ja",
        variantKey: "holo",
        rarity: "rare",
        finish: "holo",
        canonicalPrintingKey: "pokemon|pikachu|base|25|ja|holo",
      }),
    ).toBe("Pikachu · Base Set · #25 · ja · holo");
  });
});

describe("customer prediction gate", () => {
  it("defaults the customer flag off", () => {
    expect(customerPredictionsEnabled({})).toBe(false);
    expect(customerPredictionsEnabled({ PREDICTIONS_CUSTOMER_VISIBLE: "true" })).toBe(true);
    expect(
      customerPredictionsEnabled(
        { NODE_ENV: "production", PREDICTIONS_CUSTOMER_VISIBLE: "true" },
        { platformFlag: false },
      ),
    ).toBe(false);
    expect(
      customerPredictionsEnabled(
        { ISP_ENV: "staging", NODE_ENV: "production" },
        { platformFlag: true },
      ),
    ).toBe(true);
  });

  it("hides shadow predictions even when the flag and entitlement are on", () => {
    const rows = [
      { id: "p1", visibility: "shadow" },
      { id: "p2", visibility: "published" },
    ];
    expect(publishedPredictionsForCustomer(rows, { entitled: true, flagEnabled: true })).toEqual([
      { id: "p2", visibility: "published" },
    ]);
    expect(publishedPredictionsForCustomer(rows, { entitled: true, flagEnabled: false })).toEqual([]);
    expect(publishedPredictionsForCustomer(rows, { entitled: false, flagEnabled: true })).toEqual([]);
  });
});

describe("application navigation", () => {
  it("hides predictions, alerts, webhooks, and creators when gated", () => {
    const hidden = visibleAppNav({
      canViewAnalytics: true,
      canManageApiKeys: false,
      canManageMembers: false,
      canManageBilling: false,
      hasAlerts: false,
      hasWebhooks: false,
      hasCreatorAnalytics: false,
      hasPredictionsEntitlement: false,
      predictionsCustomerVisible: false,
    });
    expect(hidden.map((item) => item.key)).not.toContain("predictions");
    expect(hidden.map((item) => item.key)).not.toContain("alerts");
    expect(hidden.map((item) => item.key)).not.toContain("webhooks");
    expect(hidden.map((item) => item.key)).not.toContain("creators");
    expect(isPredictionsNavVisible({ hasPredictionsEntitlement: true, predictionsCustomerVisible: false })).toBe(
      false,
    );
  });

  it("shows predictions only with entitlement and customer flag", () => {
    const shown = visibleAppNav({
      canViewAnalytics: true,
      canManageApiKeys: true,
      canManageMembers: true,
      canManageBilling: true,
      hasAlerts: true,
      hasWebhooks: true,
      hasCreatorAnalytics: true,
      hasPredictionsEntitlement: true,
      predictionsCustomerVisible: true,
    });
    expect(shown.map((item) => item.key)).toContain("predictions");
    expect(shown.map((item) => item.key)).toContain("alerts");
  });
});

describe("five-destination navigation", () => {
  const full = {
    canViewAnalytics: true,
    canManageApiKeys: true,
    canManageMembers: true,
    canManageBilling: true,
    hasAlerts: true,
    hasWebhooks: true,
    hasCreatorAnalytics: true,
    hasPredictionsEntitlement: false,
    predictionsCustomerVisible: false,
  };

  it("keeps exactly six primary destinations and groups everything else", () => {
    const items = visibleAppNav(full);
    const primary = items.filter((item) => item.group === "primary" && !item.parent);
    expect(primary.map((item) => item.label)).toEqual(["Overview", "Topics", "Cards", "Markets", "Creators", "Watchlist"]);
    expect(items.filter((item) => item.group === "developer").map((item) => item.key)).toEqual([
      "keys",
      "webhooks",
      "usage",
    ]);
    expect(items.map((item) => item.key)).not.toContain("opportunities");
    expect(items.map((item) => item.key)).not.toContain("indices");
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it("does not offer analytics destinations to roles without analytics access", () => {
    const items = visibleAppNav({ ...full, canViewAnalytics: false });
    expect(items.map((item) => item.key)).not.toContain("cards");
    expect(items.map((item) => item.key)).not.toContain("creators");
  });
});

describe("team RBAC helpers", () => {
  it("blocks viewers from managing members and protects the last owner", () => {
    expect(() => assertCanManageTeam(false)).toThrow(/Permission denied/);
    expect(() => assertNotLastOwner({ targetRole: "owner", ownerCount: 1, removing: true })).toThrow(/last owner/);
    expect(isInvitableRole("viewer")).toBe(true);
    expect(isInvitableRole("owner")).toBe(false);
    expect(canAssignOwnerRole("admin")).toBe(false);
    expect(canAssignOwnerRole("owner")).toBe(true);
  });
});

describe("sparkline", () => {
  it("builds a path from numeric series", () => {
    expect(sparklinePath([1, 2, 3])).toContain("M");
    expect(sparklinePath([])).toBe("");
  });
});
