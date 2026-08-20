import { AppNav } from "@/components/AppNav";
import { loadAppAccess } from "@/lib/app-access";
import { visibleAppNav } from "@isp/db";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const { access, unread } = await loadAppAccess();
  return (
    <div className="app-frame">
      <AppNav items={visibleAppNav(access)} unread={unread} />
      <div className="app-content">{children}</div>
    </div>
  );
}
