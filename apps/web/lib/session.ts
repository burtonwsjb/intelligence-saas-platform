import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { tryGetAuth } from "@/lib/auth";
import {
  AuthRequiredError,
  OrganizationRequiredError,
  requireActiveOrganization,
  requireSession,
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
    return { session, organizationId };
  } catch (error) {
    if (error instanceof OrganizationRequiredError) {
      redirect("/onboarding");
    }
    throw error;
  }
}
