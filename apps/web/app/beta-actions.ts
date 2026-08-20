"use server";

import { redirect } from "next/navigation";
import {
  insertBugReport,
  insertProductFeedback,
  markOnboardingStep,
  withOrganizationContext,
} from "@isp/db";
import { getDb } from "@/lib/auth";
import { requireAppActor } from "@/lib/app-access";

export async function submitFeedbackAction(formData: FormData) {
  const { session, organizationId } = await requireAppActor();
  try {
    await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      async (scoped) => {
        await insertProductFeedback(scoped, {
          organizationId,
          userId: session.user.id,
          category: String(formData.get("category") ?? "product"),
          pageContext: String(formData.get("pageContext") ?? "") || null,
          severity: String(formData.get("severity") ?? "normal"),
          message: String(formData.get("message") ?? ""),
        });
      },
    );
  } catch {
    redirect("/app/feedback?error=rejected");
  }
  redirect("/app/feedback?ok=1");
}

export async function submitBugReportAction(formData: FormData) {
  const { session, organizationId } = await requireAppActor();
  try {
    await withOrganizationContext(
      getDb(),
      { organizationId, userId: session.user.id },
      (scoped) =>
        insertBugReport(scoped, {
          organizationId,
          userId: session.user.id,
          requestId: String(formData.get("requestId") ?? "") || null,
          route: String(formData.get("route") ?? "") || null,
          browser: String(formData.get("browser") ?? "") || null,
          description: String(formData.get("description") ?? ""),
          reproduction: String(formData.get("reproduction") ?? "") || null,
        }),
    );
  } catch {
    redirect("/app/feedback?error=rejected");
  }
  redirect("/app/feedback?ok=1");
}

export async function saveUseCaseAction(formData: FormData) {
  const { session, organizationId } = await requireAppActor();
  await withOrganizationContext(getDb(), { organizationId, userId: session.user.id }, (scoped) =>
    markOnboardingStep(scoped, {
      organizationId,
      step: "use_case",
      value: String(formData.get("useCase") ?? "").slice(0, 200),
    }),
  );
  redirect("/app/onboarding-checklist");
}
