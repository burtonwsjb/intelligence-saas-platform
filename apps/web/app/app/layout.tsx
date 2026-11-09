import { AppShell, type ShellNavSection } from "@/components/AppShell";
import type { IconName } from "@/components/Icon";
import { loadAppAccess, requireAppActor } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { checkPlatformAdminAccess, visibleAppNav, type AppNavItem } from "@isp/db";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const ICONS: Record<string, IconName> = {
  overview: "dashboard",
  topics: "topics",
  cards: "cards",
  markets: "markets",
  predictions: "forecast",
  creators: "creators",
  alerts: "watch",
  keys: "key",
  webhooks: "webhook",
  usage: "usage",
  team: "team",
  billing: "billing",
  settings: "settings",
  onboarding: "rocket",
  feedback: "feedback",
};

const SECTION_LABEL = { primary: null, developer: "Developer", account: "Account" } as const;

export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const [{ access, unread, workspaceName }, { session }] = await Promise.all([loadAppAccess(), requireAppActor()]);
  const operator = await checkPlatformAdminAccess(getDb(), {
    userId: session.user.id,
    email: session.user.email,
  }).catch(() => ({ granted: false }));
  const items = visibleAppNav(access);
  const sections: ShellNavSection[] = (["primary", "developer", "account"] as const).map((group) => ({
    label: SECTION_LABEL[group],
    items: items
      .filter((item: AppNavItem) => item.group === group)
      .map((item: AppNavItem) => ({
        key: item.key,
        href: item.href,
        label: item.label,
        icon: ICONS[item.key] ?? "dashboard",
        sub: Boolean(item.parent),
        count: item.key === "overview" ? unread : undefined,
      })),
  }));
  return (
    <AppShell
      context="app"
      sections={sections}
      user={{ name: session.user.name ?? "", email: session.user.email }}
      workspaceName={workspaceName}
      isOperator={operator.granted}
      unread={unread}
    >
      {children}
    </AppShell>
  );
}
