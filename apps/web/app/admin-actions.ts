"use server";

import { redirect } from "next/navigation";
import {
  CreatorModerationError,
  OperatorNoteRejectedError,
  SupportCaseRejectedError,
  insertOperatorNote,
  insertSupportCase,
  setCreatorTrustKeepingHistory,
  setFeatureFlag,
  setSupportCaseStatus,
  upsertOperatorIndexDefinition,
  createBetaInvite,
  insertBreakGlassAudit,
  isFeatureFlagKey,
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

export async function createBetaInviteAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/beta?error=config");
  }
  const days = Number(formData.get("days") ?? "14");
  const maxUses = Number(formData.get("maxUses") ?? "1");
  try {
    const created = await createBetaInvite(operator.adminDb, {
      email: String(formData.get("email") ?? "").trim() || null,
      organizationHint: String(formData.get("organizationHint") ?? "").trim() || null,
      cohort: String(formData.get("cohort") ?? "beta_wave_1"),
      expiresAt: new Date(Date.now() + Math.max(1, days) * 86_400_000),
      maxUses: Number.isFinite(maxUses) ? maxUses : 1,
      createdByUserId: operator.session.user.id,
    });
    await insertBreakGlassAudit(operator.adminDb, {
      actorUserId: operator.session.user.id,
      action: "beta.invite",
      metadata: { inviteId: created.id },
    });
    redirect(`/admin/beta?token=${encodeURIComponent(created.token)}`);
  } catch {
    redirect("/admin/beta?error=rejected");
  }
}

export async function setFeatureFlagAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/beta?error=config");
  }
  const key = String(formData.get("key") ?? "");
  if (!isFeatureFlagKey(key)) {
    redirect("/admin/beta?error=rejected");
  }
  await setFeatureFlag(operator.adminDb, {
    key,
    enabled: String(formData.get("enabled") ?? "") === "true",
    actorUserId: operator.session.user.id,
  });
  await insertBreakGlassAudit(operator.adminDb, {
    actorUserId: operator.session.user.id,
    action: "feature.flag",
    metadata: { key },
  });
  redirect("/admin/beta");
}
