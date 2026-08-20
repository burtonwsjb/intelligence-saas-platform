import type { ReactNode } from "react";
import { AdminNav } from "@/components/AdminNav";
import { requirePlatformOperator } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operator = await requirePlatformOperator();
  if (operator.denied) {
    return (
      <>
        <h1>Admin</h1>
        <p className="muted">
          Platform operators are not a tenant role. This console stays locked without a
          server-checked <code>platform_admins</code> grant.
        </p>
      </>
    );
  }
  return (
    <div className="app-frame">
      <AdminNav />
      <div className="app-content">
        {!operator.adminDb ? (
          <p className="form-error">
            Platform admin database role is not configured. Set DATABASE_ADMIN_URL and
            APP_ADMIN_PASSWORD. Cross-tenant CRM, creator exclusion, and break-glass writes stay
            fail-closed.
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
