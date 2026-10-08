"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import {
  CreatorHandleError,
  CreatorListLimitError,
  removeFromCreatorList,
  requestCreatorFollow,
  setCreatorPreference,
  withOrganizationContext,
  type CreatorPlatform,
} from "@isp/db";

// Only same-app creator pages are valid return targets.
function returnPath(formData: FormData, fallback = "/app/creators?list=mine"): string {
  const value = String(formData.get("returnTo") ?? "");
  return /^\/app\/creators(\/[A-Za-z0-9_%.-]+)?(\?[A-Za-z0-9=&_%-]*)?$/.test(value) ? value : fallback;
}

function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

async function requireCreatorList() {
  const actor = await loadAppAccess();
  if (!actor.access.hasCreatorAnalytics || !actor.access.canViewAnalytics) {
    redirect("/app/creators");
  }
  return actor;
}

export async function addCreatorByLinkAction(formData: FormData) {
  const { organizationId, userId } = await requireCreatorList();
  const platformInput = String(formData.get("platform") ?? "");
  const platform: CreatorPlatform | undefined =
    platformInput === "youtube" || platformInput === "reddit" ? platformInput : undefined;
  let status: string;
  try {
    const result = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
      requestCreatorFollow(scoped, { organizationId, userId, input: String(formData.get("link") ?? ""), platform }),
    );
    status = result.status === "resolved" ? "added" : "queued";
  } catch (error) {
    if (error instanceof CreatorHandleError) redirect(withParam("/app/creators?list=mine", "error", error.message));
    if (error instanceof CreatorListLimitError) redirect(withParam("/app/creators?list=mine", "error", error.message));
    throw error;
  }
  redirect(withParam("/app/creators?list=mine", "notice", status));
}

export async function setCreatorPreferenceAction(formData: FormData) {
  const { organizationId, userId } = await requireCreatorList();
  const preference = String(formData.get("preference") ?? "");
  const creatorId = String(formData.get("creatorId") ?? "");
  const back = returnPath(formData);
  if ((preference !== "follow" && preference !== "hide") || !creatorId) redirect(back);
  try {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
      setCreatorPreference(scoped, { organizationId, userId, creatorId, preference: preference as "follow" | "hide" }),
    );
  } catch (error) {
    if (error instanceof CreatorHandleError || error instanceof CreatorListLimitError) {
      redirect(withParam(back, "error", error.message));
    }
    throw error;
  }
  redirect(back);
}

export async function removeCreatorListEntryAction(formData: FormData) {
  const { organizationId, userId } = await requireCreatorList();
  const id = String(formData.get("entryId") ?? "");
  if (id) {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) => removeFromCreatorList(scoped, id));
  }
  redirect(returnPath(formData));
}
