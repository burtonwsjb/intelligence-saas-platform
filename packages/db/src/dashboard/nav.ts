export type AppNavItem = {
  href: string;
  label: string;
  key: string;
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

const ALWAYS: AppNavItem[] = [
  { href: "/app", label: "Overview", key: "overview" },
  { href: "/app/usage", label: "Usage", key: "usage" },
  { href: "/app/team", label: "Team", key: "team" },
  { href: "/app/billing", label: "Billing", key: "billing" },
  { href: "/app/settings", label: "Settings", key: "settings" },
];

export function visibleAppNav(access: AppNavAccess): AppNavItem[] {
  const items: AppNavItem[] = [];
  if (access.canViewAnalytics) {
    items.push(
      { href: "/app", label: "Overview", key: "overview" },
      { href: "/app/opportunities", label: "Opportunities", key: "opportunities" },
      { href: "/app/markets", label: "Markets", key: "markets" },
      { href: "/app/cards", label: "Cards", key: "cards" },
    );
    if (access.hasCreatorAnalytics) {
      items.push({ href: "/app/creators", label: "Creators", key: "creators" });
    }
    if (access.hasPredictionsEntitlement && access.predictionsCustomerVisible) {
      items.push({ href: "/app/predictions", label: "Predictions", key: "predictions" });
    }
    items.push({ href: "/app/indices", label: "Indices", key: "indices" });
  }
  if (access.hasAlerts) {
    items.push({ href: "/app/alerts", label: "Alerts", key: "alerts" });
  }
  items.push({ href: "/app/keys", label: "API", key: "keys" });
  if (access.hasWebhooks) {
    items.push({ href: "/app/webhooks", label: "Webhooks", key: "webhooks" });
  }
  items.push(
    { href: "/app/usage", label: "Usage", key: "usage" },
    { href: "/app/feedback", label: "Feedback", key: "feedback" },
    { href: "/app/onboarding-checklist", label: "Onboarding", key: "onboarding" },
    { href: "/app/team", label: "Team", key: "team" },
    { href: "/app/billing", label: "Billing", key: "billing" },
    { href: "/app/settings", label: "Settings", key: "settings" },
  );
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    return true;
  });
}

export function isPredictionsNavVisible(access: Pick<AppNavAccess, "hasPredictionsEntitlement" | "predictionsCustomerVisible">) {
  return access.hasPredictionsEntitlement && access.predictionsCustomerVisible;
}

void ALWAYS;
