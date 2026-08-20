"use server";

import { redirect } from "next/navigation";
import {
  CreatorModerationError,
  OperatorNoteRejectedError,
  SupportCaseRejectedError,
  insertOperatorNote,
  insertSupportCase,
  setCreatorTrustKeepingHistory,
  setSupportCaseStatus,
  upsertOperatorIndexDefinition,
} from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";

export async function setCreatorTrustAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/creators?error=config");
  }
  try {
    await setCreatorTrustKeepingHistory(operator.adminDb, {
      creatorId: String(formData.get("creatorId") ?? ""),
      actorUserId: operator.session.user.id,
      trustState: String(formData.get("trustState") ?? ""),
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof CreatorModerationError) {
      redirect("/admin/creators?error=rejected");
    }
    throw error;
  }
  redirect("/admin/creators");
}

export async function upsertIndexAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/indices?error=config");
  }
  const languageCode = String(formData.get("languageCode") ?? "en");
  const gameKey = String(formData.get("gameKey") ?? "");
  try {
    await upsertOperatorIndexDefinition(operator.adminDb, {
      actorUserId: operator.session.user.id,
      indexKey: String(formData.get("indexKey") ?? ""),
      name: String(formData.get("name") ?? ""),
      gameKey,
      languageCode,
      membershipRule: {
        game_key: gameKey,
        language_code: languageCode,
      },
    });
  } catch {
    redirect("/admin/indices?error=rejected");
  }
  redirect("/admin/indices");
}

export async function addOperatorNoteAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!operator.adminDb) {
    redirect(`/admin/customers/${organizationId}?error=config`);
  }
  try {
    await insertOperatorNote(operator.adminDb, {
      organizationId,
      authorUserId: operator.session.user.id,
      category: "support",
      body: String(formData.get("body") ?? ""),
    });
  } catch (error) {
    if (error instanceof OperatorNoteRejectedError) {
      redirect(`/admin/customers/${organizationId}?error=rejected`);
    }
    throw error;
  }
  redirect(`/admin/customers/${organizationId}`);
}

export async function createSupportCaseAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/support?error=config");
  }
  try {
    await insertSupportCase(operator.adminDb, {
      organizationId: String(formData.get("organizationId") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
      createdByUserId: operator.session.user.id,
    });
  } catch (error) {
    if (error instanceof SupportCaseRejectedError) {
      redirect("/admin/support?error=rejected");
    }
    throw error;
  }
  redirect("/admin/support");
}

export async function setSupportStatusAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/support?error=config");
  }
  await setSupportCaseStatus(operator.adminDb, {
    id: String(formData.get("id") ?? ""),
    status: String(formData.get("status") ?? ""),
    actorUserId: operator.session.user.id,
  });
  redirect("/admin/support");
}
