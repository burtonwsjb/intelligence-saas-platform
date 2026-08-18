"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import {
  parseOrganizationName,
  slugifyOrganizationName,
} from "@/lib/organization-input";
import { requireSession } from "@isp/auth";

export async function createInitialOrganization(formData: FormData) {
  const name = parseOrganizationName(formData.get("name"));
  if (!name) {
    redirect("/onboarding?error=invalid");
  }

  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  try {
    requireSession(session);
  } catch {
    redirect("/login");
  }

  const existing = await auth.api.listOrganizations({
    headers: requestHeaders,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: existing[0]!.id },
    });
    redirect("/app");
  }

  const created = await auth.api.createOrganization({
    headers: requestHeaders,
    body: {
      name,
      slug: `${slugifyOrganizationName(name)}-${crypto.randomUUID().slice(0, 8)}`,
    },
  });

  if (!created?.id) {
    redirect("/onboarding?error=create");
  }

  await auth.api.setActiveOrganization({
    headers: requestHeaders,
    body: { organizationId: created.id },
  });
  redirect("/app");
}

export async function signOutAction() {
  const requestHeaders = await headers();
  await getAuth().api.signOut({ headers: requestHeaders });
  redirect("/");
}
