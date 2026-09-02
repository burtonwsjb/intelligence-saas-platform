"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDb } from "@/lib/auth";
import { countActiveApiKeys, member, withOrganizationContext } from "@isp/db";
import {
  createTenantApiKey,
  requireApiKeyPepper,
  requirePermission,
  requireSession,
  requireUsableTenant,
  revokeTenantApiKey,
  rotateTenantApiKey,
} from "@isp/auth";
import { QuotaExceededError, assertTenantWithinLimit } from "@isp/billing";
import { and, eq } from "drizzle-orm";
import { setSecretFlash } from "@/lib/secret-flash";

async function requireKeyActor() {
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
  requirePermission(membership?.role, "canManageApiKeys");
  return { session, organizationId, role: membership!.role };
}

export async function createApiKeyAction(formData: FormData) {
  const { session, organizationId, role } = await requireKeyActor();
  const name = String(formData.get("name") ?? "");
  const scopes = formData.getAll("scopes");
  const expiresRaw = String(formData.get("expiresAt") ?? "").trim();
  const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
  let created: { fullKey: string };
  try {
    created = await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      async (scoped) => {
        await assertTenantWithinLimit(
          scoped,
          organizationId,
          "api_keys",
          await countActiveApiKeys(scoped, organizationId),
        );
        return createTenantApiKey(scoped, {
          organizationId,
          actorUserId: session.user.id,
          actorRole: role,
          name,
          scopes,
          pepper: requireApiKeyPepper(),
          expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
        });
      },
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      redirect("/app/keys?error=quota");
    }
    throw error;
  }
  await setSecretFlash("api_key", created.fullKey);
  redirect("/app/keys");
}

export async function revokeApiKeyAction(formData: FormData) {
  const { session, organizationId, role } = await requireKeyActor();
  const apiKeyId = String(formData.get("apiKeyId") ?? "");
  await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    (scoped) =>
      revokeTenantApiKey(scoped, {
        organizationId,
        actorUserId: session.user.id,
        actorRole: role,
        apiKeyId,
      }),
  );
  redirect("/app/keys");
}

export async function rotateApiKeyAction(formData: FormData) {
  const { session, organizationId, role } = await requireKeyActor();
  const apiKeyId = String(formData.get("apiKeyId") ?? "");
  const name = String(formData.get("name") ?? "");
  const scopes = String(formData.get("scopes") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const created = await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    (scoped) =>
      rotateTenantApiKey(scoped, {
        organizationId,
        actorUserId: session.user.id,
        actorRole: role,
        apiKeyId,
        name,
        scopes,
        pepper: requireApiKeyPepper(),
      }),
  );
  await setSecretFlash("api_key", created.fullKey);
  redirect("/app/keys");
}
