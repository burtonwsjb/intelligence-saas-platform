"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import { markAllNotificationsRead, markNotificationRead, withOrganizationContext } from "@isp/db";

export async function markAllReadAction() {
  const { organizationId, userId } = await loadAppAccess();
  await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    markAllNotificationsRead(scoped, { organizationId, userId }),
  );
  redirect("/app");
}

export async function markReadAction(formData: FormData) {
  const { organizationId, userId } = await loadAppAccess();
  const notificationId = String(formData.get("notificationId") ?? "");
  await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    markNotificationRead(scoped, { organizationId, userId, notificationId }),
  );
  redirect("/app");
}
