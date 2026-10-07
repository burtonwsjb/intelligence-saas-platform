export type AppNavGroup = "primary" | "developer" | "account";

export type AppNavItem = {
  href: string;
  label: string;
  key: string;
  group: AppNavGroup;
  /** Key of the primary destination this item sits under, when it is a sub-view. */
  parent?: string;
};

export type AppNavAccess = {
  canViewAnalytics: boolean;
  canManageApiKeys: boolean;
  canManageMembers: boolean;
  canManageBilling: boolean;
  hasAlerts: boolean;
  hasWebhooks: boolean;
  hasCreatorAnalytics: boolean;
  hasPredictionsEntitlement: boolean;
  predictionsCustomerVisible: boolean;
};

// Five primary destinations: Overview, Cards, Markets, Creators, Watchlist.
// Everything else is a secondary Developer or Account item, so the primary
// navigation stays the same size however many account features exist.
export function visibleAppNav(access: AppNavAccess): AppNavItem[] {
  const items: AppNavItem[] = [];
  if (access.canViewAnalytics) {
    items.push(
      { href: "/app", label: "Overview", key: "overview", group: "primary" },
      { href: "/app/cards", label: "Cards", key: "cards", group: "primary" },
      { href: "/app/markets", label: "Markets", key: "markets", group: "primary" },
    );
    if (access.hasPredictionsEntitlement && access.predictionsCustomerVisible) {
      items.push({ href: "/app/predictions", label: "Forecasts", key: "predictions", group: "primary", parent: "markets" });
    }
    if (access.hasCreatorAnalytics) {
      items.push({ href: "/app/creators", label: "Creators", key: "creators", group: "primary" });
    }
  }
  if (access.hasAlerts) {
    items.push({ href: "/app/alerts", label: "Watchlist", key: "alerts", group: "primary" });
  }
  items.push({ href: "/app/keys", label: "API keys", key: "keys", group: "developer" });
  if (access.hasWebhooks) {
    items.push({ href: "/app/webhooks", label: "Webhooks", key: "webhooks", group: "developer" });
  }
  items.push(
    { href: "/app/usage", label: "Usage", key: "usage", group: "developer" },
    { href: "/app/team", label: "Team", key: "team", group: "account" },
    { href: "/app/billing", label: "Billing", key: "billing", group: "account" },
    { href: "/app/settings", label: "Settings", key: "settings", group: "account" },
    { href: "/app/onboarding-checklist", label: "Getting started", key: "onboarding", group: "account" },
    { href: "/app/feedback", label: "Feedback", key: "feedback", group: "account" },
  );
  return items;
}

export function isPredictionsNavVisible(access: Pick<AppNavAccess, "hasPredictionsEntitlement" | "predictionsCustomerVisible">) {
  return access.hasPredictionsEntitlement && access.predictionsCustomerVisible;
}
