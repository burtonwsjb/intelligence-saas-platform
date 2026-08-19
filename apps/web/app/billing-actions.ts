"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDb } from "@/lib/auth";
import { member, withOrganizationContext } from "@isp/db";
import {
  OrganizationAccessError,
  requirePermission,
  requireSession,
  requireUsableTenant,
} from "@isp/auth";
import { and, eq } from "drizzle-orm";
import { createCheckoutSession, createPortalSession } from "@isp/billing";

function isRedirectError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

async function requireBillingActor() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  requireSession(session);
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new OrganizationAccessError();
  }
  await requireUsableTenant(getDb(), organizationId, session.user.id);
  const [membership] = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  requirePermission(membership?.role, "canManageBilling");
  return { session, organizationId };
}

export async function startCheckout(formData: FormData) {
  try {
    const { session, organizationId } = await requireBillingActor();
    const planKey = String(formData.get("planKey") ?? "");
    const origin = process.env.APP_URL ?? "http://localhost:3000";
    const { url } = await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      (scoped) =>
        createCheckoutSession(scoped, {
          organizationId,
          actorUserId: session.user.id,
          planKey,
          successUrl: `${origin}/app/billing?checkout=return`,
          cancelUrl: `${origin}/app/billing?checkout=cancel`,
          tenantName: session.user.email ?? organizationId,
        }),
    );
    redirect(url);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    redirect("/app/billing?error=billing");
  }
}

export async function openBillingPortal() {
  try {
    const { session, organizationId } = await requireBillingActor();
    const origin = process.env.APP_URL ?? "http://localhost:3000";
    const { url } = await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      (scoped) =>
        createPortalSession(scoped, {
          organizationId,
          actorUserId: session.user.id,
          returnUrl: `${origin}/app/billing`,
        }),
    );
    redirect(url);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    redirect("/app/billing?error=portal");
  }
}
