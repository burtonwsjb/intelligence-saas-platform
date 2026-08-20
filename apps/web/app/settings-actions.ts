"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { loadAppAccess, requireAppActor } from "@/lib/app-access";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NotificationPreferenceDeniedError,
  getCrmOrganizationProfile,
  setNotificationPreference,
  upsertCrmOrganizationProfile,
  upsertCrmUserProfile,
  withOrganizationContext,
} from "@isp/db";

export async function updateOrgProfileAction(formData: FormData) {
  const { session, organizationId } = await requireAppActor("canManageMembers");
  await withOrganizationContext(getDb(), { organizationId, userId: session.user.id }, async (scoped) => {
    const existing = await getCrmOrganizationProfile(scoped, organizationId);
    await upsertCrmOrganizationProfile(scoped, {
      organizationId,
      displayName: String(formData.get("displayName") ?? existing?.displayName ?? "Workspace"),
      website: String(formData.get("website") ?? "") || null,
      industry: String(formData.get("industry") ?? "") || null,
      primaryUseCase: String(formData.get("primaryUseCase") ?? "") || null,
      leadSource: existing?.leadSource,
      signupSource: existing?.signupSource,
    });
  });
  redirect("/app/settings");
}

export async function updateUserProfileAction(formData: FormData) {
  const { organizationId, userId } = await loadAppAccess();
  await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    upsertCrmUserProfile(scoped, {
      organizationId,
      userId,
      displayName: String(formData.get("displayName") ?? "") || null,
      jobTitle: String(formData.get("jobTitle") ?? "") || null,
      timezone: String(formData.get("timezone") ?? "") || null,
    }),
  );
  redirect("/app/settings");
}

export async function updatePreferenceAction(formData: FormData) {
  const { organizationId, userId } = await loadAppAccess();
  const category = String(formData.get("category") ?? "");
  const channel = String(formData.get("channel") ?? "");
  if (
    !(NOTIFICATION_CATEGORIES as readonly string[]).includes(category) ||
    !(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)
  ) {
    redirect("/app/settings?error=invalid");
  }
  try {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
      setNotificationPreference(scoped, {
        organizationId,
        userId,
        category,
        channel,
        optedIn: formData.get("optedIn") === "on",
      }),
    );
  } catch (error) {
    if (error instanceof NotificationPreferenceDeniedError) {
      redirect("/app/settings?error=required");
    }
    throw error;
  }
  redirect("/app/settings");
}
