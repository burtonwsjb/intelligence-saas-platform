"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { requireAppActor } from "@/lib/app-access";
import {
  WebhookUrlRejectedError,
  disableWebhookEndpoint,
  deleteWebhookEndpoint,
  insertWebhookEndpoint,
  rotateWebhookSecret,
  withOrganizationContext,
} from "@isp/db";
import { requireApiKeyPepper } from "@isp/auth";
import { tenantHasFeature } from "@isp/billing";

async function requireWebhookManager() {
  const actor = await requireAppActor("canManageApiKeys");
  const entitled = await withOrganizationContext(
    getDb(),
    { organizationId: actor.organizationId, userId: actor.session.user.id },
    (scoped) => tenantHasFeature(scoped, actor.organizationId, "webhooks"),
  );
  if (!entitled) {
    redirect("/app/webhooks?error=entitlement");
  }
  return actor;
}

export async function createWebhookAction(formData: FormData) {
  const { session, organizationId } = await requireWebhookManager();
  const events = formData.getAll("events").map((value) => String(value));
  try {
    const created = await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      (scoped) =>
        insertWebhookEndpoint(scoped, {
          organizationId,
          url: String(formData.get("url") ?? ""),
          eventTypes: events,
          pepper: requireApiKeyPepper(),
        }),
    );
    redirect(`/app/webhooks?created=${encodeURIComponent(created.secret)}`);
  } catch (error) {
    if (error instanceof WebhookUrlRejectedError) {
      redirect("/app/webhooks?error=rejected");
    }
    if (error instanceof Error && error.message.includes("Unsupported webhook")) {
      redirect("/app/webhooks?error=rejected");
    }
    throw error;
  }
}

export async function disableWebhookAction(formData: FormData) {
  const { session, organizationId } = await requireWebhookManager();
  await withOrganizationContext(getDb(), { organizationId, userId: session.user.id }, (scoped) =>
    disableWebhookEndpoint(scoped, {
      organizationId,
      endpointId: String(formData.get("endpointId") ?? ""),
    }),
  );
  redirect("/app/webhooks");
}

export async function deleteWebhookAction(formData: FormData) {
  const { session, organizationId } = await requireWebhookManager();
  await withOrganizationContext(getDb(), { organizationId, userId: session.user.id }, (scoped) =>
    deleteWebhookEndpoint(scoped, {
      organizationId,
      endpointId: String(formData.get("endpointId") ?? ""),
    }),
  );
  redirect("/app/webhooks");
}

export async function rotateWebhookAction(formData: FormData) {
  const { session, organizationId } = await requireWebhookManager();
  const secret = await withOrganizationContext(
    getDb(),
    { organizationId, userId: session.user.id },
    (scoped) =>
      rotateWebhookSecret(scoped, {
        organizationId,
        endpointId: String(formData.get("endpointId") ?? ""),
        pepper: requireApiKeyPepper(),
      }),
  );
  if (!secret) {
    redirect("/app/webhooks?error=missing");
  }
  redirect(`/app/webhooks?created=${encodeURIComponent(secret)}`);
}
