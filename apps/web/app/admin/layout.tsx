import type { ReactNode } from "react";
import { AppShell, type ShellNavSection } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { requirePlatformOperator } from "@/lib/platform-admin";
import Link from "next/link";

export const dynamic = "force-dynamic";

const SECTIONS: ShellNavSection[] = [
  { label: null, items: [{ key: "home", href: "/admin", label: "Control center", icon: "dashboard" }] },
  {
    label: "Data",
    items: [
      { key: "sources", href: "/admin/sources", label: "Sources", icon: "sources" },
      { key: "discovery", href: "/admin/discovery", label: "Discovery", icon: "discovery" },
      { key: "creators", href: "/admin/creators", label: "Influencers", icon: "creators" },
      { key: "quarantine", href: "/admin/quarantine", label: "Quarantine", icon: "quarantine" },
      { key: "indices", href: "/admin/indices", label: "Indices", icon: "indices" },
      { key: "predictions", href: "/admin/predictions", label: "Forecasts", icon: "forecast" },
    ],
  },
  {
    label: "People",
    items: [
      { key: "customers", href: "/admin/customers", label: "Customers", icon: "customers" },
      { key: "beta", href: "/admin/beta", label: "Invites & features", icon: "beta" },
      { key: "support", href: "/admin/support", label: "Support", icon: "support" },
    ],
  },
  {
    label: "System",
    items: [
      { key: "health", href: "/admin/health", label: "Health & worker", icon: "health" },
      { key: "config", href: "/admin/config", label: "Configuration", icon: "config" },
      { key: "audit", href: "/admin/audit", label: "Audit log", icon: "audit" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operator = await requirePlatformOperator();
  if (operator.denied) {
    return (
      <div className="locked-panel">
        <span className="locked-icon">
          <Icon name="shield" size={28} />
        </span>
        <h1>Admin is for platform operators</h1>
        <p className="muted">
          This console stays locked without a server-checked <code>platform_admins</code> grant.
        </p>
        <Link className="button" href="/app">
          Back to the dashboard
        </Link>
      </div>
    );
  }
  return (
    <AppShell
      context="admin"
      sections={SECTIONS}
      user={{ name: operator.session.user.name ?? "", email: operator.session.user.email }}
      isOperator
    >
      {!operator.adminDb ? (
        <div className="notice notice-bad">
          Platform admin database role is not configured. Set DATABASE_ADMIN_URL and APP_ADMIN_PASSWORD. Cross-tenant
          CRM, creator exclusion, and break-glass writes stay fail-closed.
        </div>
      ) : null}
      {children}
    </AppShell>
  );
}
