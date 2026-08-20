import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDb } from "@/lib/auth";
import {
  countUnreadNotifications,
  customerPredictionsEnabled,
  member,
  withOrganizationContext,
  type AppNavAccess,
} from "@isp/db";
import {
  hasPermission,
  requirePermission,
  requireSession,
  requireUsableTenant,
  type PermissionName,
} from "@isp/auth";
import { tenantHasFeature } from "@isp/billing";
import { and, eq } from "drizzle-orm";

export async function requireAppActor(permission?: PermissionName) {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  requireSession(session);
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    redirect("/onboarding");
  }
  await requireUsableTenant(getDb(), organizationId, session.user.id);
  const [membership] = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  if (permission) {
    requirePermission(membership?.role, permission);
  }
  return { session, organizationId, role: membership?.role ?? null };
}

export async function loadAppAccess(): Promise<{
  organizationId: string;
  userId: string;
  role: string | null;
  access: AppNavAccess;
  unread: number;
}> {
  const { session, organizationId, role } = await requireAppActor();
  const userId = session.user.id;
  const snapshot = await withOrganizationContext(
    getDb(),
    { organizationId, userId },
    async (scoped) => {
      const [hasAlerts, hasWebhooks, hasCreatorAnalytics, hasPredictions, unread] = await Promise.all([
        tenantHasFeature(scoped, organizationId, "alerts"),
        tenantHasFeature(scoped, organizationId, "webhooks"),
        tenantHasFeature(scoped, organizationId, "creator_analytics"),
        tenantHasFeature(scoped, organizationId, "predictions"),
        countUnreadNotifications(scoped, { organizationId, userId }),
      ]);
      return { hasAlerts, hasWebhooks, hasCreatorAnalytics, hasPredictions, unread };
    },
  );
  return {
    organizationId,
    userId,
    role,
    unread: snapshot.unread,
    access: {
      canViewAnalytics: hasPermission(role, "canViewAnalytics"),
      canManageApiKeys: hasPermission(role, "canManageApiKeys"),
      canManageMembers: hasPermission(role, "canManageMembers"),
      canManageBilling: hasPermission(role, "canManageBilling"),
      hasAlerts: snapshot.hasAlerts,
      hasWebhooks: snapshot.hasWebhooks,
      hasCreatorAnalytics: snapshot.hasCreatorAnalytics,
      hasPredictionsEntitlement: snapshot.hasPredictions,
      predictionsCustomerVisible: customerPredictionsEnabled(),
    },
  };
}
