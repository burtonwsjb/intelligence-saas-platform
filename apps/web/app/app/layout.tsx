import { AppNav } from "@/components/AppNav";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import { organization, visibleAppNav, withOrganizationContext } from "@isp/db";
import { eq } from "drizzle-orm";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const { access, unread, organizationId, userId } = await loadAppAccess();
  const [workspace] = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    scoped.select({ name: organization.name }).from(organization).where(eq(organization.id, organizationId)).limit(1),
  );
  return (
    <div className="app-frame">
      <AppNav items={visibleAppNav(access)} unread={unread} workspaceName={workspace?.name ?? null} />
      <div className="app-content">{children}</div>
    </div>
  );
}
