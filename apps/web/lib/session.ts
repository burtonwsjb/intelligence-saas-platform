import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, tryGetAuth } from "@/lib/auth";
import {
  AuthRequiredError,
  OrganizationRequiredError,
  TenantInactiveError,
  requireActiveOrganization,
  requireSession,
  requireUsableTenant,
} from "@isp/auth";

export const dynamic = "force-dynamic";

export async function getOptionalSession() {
  const auth = tryGetAuth();
  if (!auth) {
    return null;
  }
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requirePageSession() {
  const session = await getOptionalSession();
  try {
    requireSession(session);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      redirect("/login");
    }
    throw error;
  }
  return session;
}

export async function requirePageOrganization() {
  const session = await requirePageSession();
  try {
    const organizationId = requireActiveOrganization(session);
    await requireUsableTenant(getDb(), organizationId, session.user.id);
    return { session, organizationId };
  } catch (error) {
    if (error instanceof OrganizationRequiredError) {
      redirect("/onboarding");
    }
    if (error instanceof TenantInactiveError) {
      redirect("/workspace-unavailable");
    }
    throw error;
  }
}
