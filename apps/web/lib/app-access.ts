import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDb } from "@/lib/auth";
import {
  countUnreadNotifications,
  customerPredictionsEnabled,
  featureFlagEnabled,
  listHiddenCreatorIds,
  member,
  organization,
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
import { cache } from "react";

/**
 * The signed-in actor, read once per request. The app layout and the page both
 * need it; React's request cache stops them each repeating the session, tenant
 * and membership lookups (each a database round trip).
 */
const loadAppActor = cache(async () => {
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
  return { session, organizationId, role: membership?.role ?? null };
});

export async function requireAppActor(permission?: PermissionName) {
  const actor = await loadAppActor();
  if (permission) {
    requirePermission(actor.role, permission);
  }
  return actor;
}

export const loadAppAccess = cache(async (): Promise<{
  organizationId: string;
  userId: string;
  role: string | null;
  access: AppNavAccess;
  unread: number;
  workspaceName: string | null;
}> => {
  const { session, organizationId, role } = await requireAppActor();
  const userId = session.user.id;
  const snapshot = await withOrganizationContext(
    getDb(),
    { organizationId, userId },
    async (scoped) => {
      const [hasAlerts, hasWebhooks, hasCreatorAnalytics, hasPredictions, unread, workspace] = await Promise.all([
        tenantHasFeature(scoped, organizationId, "alerts"),
        tenantHasFeature(scoped, organizationId, "webhooks"),
        tenantHasFeature(scoped, organizationId, "creator_analytics"),
        tenantHasFeature(scoped, organizationId, "predictions"),
        countUnreadNotifications(scoped, { organizationId, userId }),
        scoped.select({ name: organization.name }).from(organization).where(eq(organization.id, organizationId)).limit(1),
      ]);
      return { hasAlerts, hasWebhooks, hasCreatorAnalytics, hasPredictions, unread, workspaceName: workspace[0]?.name ?? null };
    },
  );
  const platformFlag = await featureFlagEnabled(getDb(), "predictions_customer_visible");
  return {
    organizationId,
    userId,
    role,
    unread: snapshot.unread,
    workspaceName: snapshot.workspaceName,
    access: {
      canViewAnalytics: hasPermission(role, "canViewAnalytics"),
      canManageApiKeys: hasPermission(role, "canManageApiKeys"),
      canManageMembers: hasPermission(role, "canManageMembers"),
      canManageBilling: hasPermission(role, "canManageBilling"),
      hasAlerts: snapshot.hasAlerts,
      hasWebhooks: snapshot.hasWebhooks,
      hasCreatorAnalytics: snapshot.hasCreatorAnalytics,
      hasPredictionsEntitlement: snapshot.hasPredictions,
      predictionsCustomerVisible: customerPredictionsEnabled(process.env, { platformFlag }),
    },
  };
});

export const ANALYTICS_LOCKED_BODY =
  "Your role in this workspace does not include market and card analytics. Ask a workspace owner or admin for access.";

/** Creators this workspace hid; their posts and calls are left out of its views. */
export async function loadHiddenCreatorIds(organizationId: string, userId: string): Promise<string[]> {
  return withOrganizationContext(getDb(), { organizationId, userId }, listHiddenCreatorIds);
}
