"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import { TopicInputError, addTenantTopic, removeTenantTopic, setTenantTopicStatus, withOrganizationContext } from "@isp/db";

async function requireTopics() {
  const actor = await loadAppAccess();
  if (!actor.access.canViewAnalytics) redirect("/app");
  return actor;
}

export async function addTopicAction(formData: FormData) {
  const { organizationId, userId } = await requireTopics();
  let id: string;
  try {
    const result = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
      addTenantTopic(scoped, { organizationId, userId, query: String(formData.get("query") ?? "") }),
    );
    id = result.id;
  } catch (error) {
    if (error instanceof TopicInputError) redirect(`/app/topics?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  redirect(`/app/topics/${encodeURIComponent(id)}`);
}

export async function setTopicStatusAction(formData: FormData) {
  const { organizationId, userId } = await requireTopics();
  const id = String(formData.get("topicId") ?? "");
  const status = String(formData.get("status") ?? "") === "paused" ? "paused" : "active";
  if (id) {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) => setTenantTopicStatus(scoped, { id, status }));
  }
  redirect(String(formData.get("returnTo") ?? "") === "detail" && id ? `/app/topics/${encodeURIComponent(id)}` : "/app/topics");
}

export async function removeTopicAction(formData: FormData) {
  const { organizationId, userId } = await requireTopics();
  const id = String(formData.get("topicId") ?? "");
  if (id) {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) => removeTenantTopic(scoped, id));
  }
  redirect("/app/topics");
}
