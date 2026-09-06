"use server";

import { redirect } from "next/navigation";
import { setSecretFlash } from "@/lib/secret-flash";
import {
  CreatorModerationError,
  OperatorNoteRejectedError,
  ProviderAdminError,
  SupportCaseRejectedError,
  insertBreakGlassAudit,
  insertOperatorNote,
  insertSupportCase,
  setCreatorTrustKeepingHistory,
  setFeatureFlag,
  setSupportCaseStatus,
  upsertOperatorIndexDefinition,
  createBetaInvite,
  isFeatureFlagKey,
  requestDiscoveryRun,
  DiscoveryConfigurationError,
  setDiscoveredCreatorState,
  setDiscoveryTopicEnabled,
  setProviderEnabled,
  setProviderPaused,
  triggerProviderSync,
  retryProviderJob,
  reviewMarketQuarantine,
  resolveIntelligenceQuarantine,
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
    await setSecretFlash("beta_invite", created.token);
    redirect("/admin/beta");
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

export async function setProviderEnabledAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/sources?error=config");
  }
  try {
    await setProviderEnabled(operator.adminDb, {
      providerKey: String(formData.get("providerKey") ?? ""),
      actorUserId: operator.session.user.id,
      enabled: String(formData.get("enabled") ?? "") === "true",
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ProviderAdminError) {
      redirect("/admin/sources?error=rejected");
    }
    throw error;
  }
  redirect("/admin/sources");
}

export async function setProviderPausedAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/sources?error=config");
  }
  try {
    await setProviderPaused(operator.adminDb, {
      providerKey: String(formData.get("providerKey") ?? ""),
      actorUserId: operator.session.user.id,
      paused: String(formData.get("paused") ?? "") === "true",
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ProviderAdminError) {
      redirect("/admin/sources?error=rejected");
    }
    throw error;
  }
  redirect("/admin/sources");
}

export async function triggerProviderSyncAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/sources?error=config");
  }
  try {
    await triggerProviderSync(operator.adminDb, {
      providerKey: String(formData.get("providerKey") ?? ""),
      actorUserId: operator.session.user.id,
      limit: 10,
      confirm: String(formData.get("confirm") ?? "") === "yes",
    });
  } catch (error) {
    if (error instanceof ProviderAdminError) {
      redirect("/admin/sources?error=rejected");
    }
    throw error;
  }
  redirect("/admin/sources");
}

export async function retryProviderJobAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/sources?error=config");
  }
  try {
    await retryProviderJob(operator.adminDb, {
      jobId: String(formData.get("jobId") ?? ""),
      actorUserId: operator.session.user.id,
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (error) {
    if (error instanceof ProviderAdminError) {
      redirect("/admin/sources?error=rejected");
    }
    throw error;
  }
  redirect("/admin/sources");
}

export async function setDiscoveryTopicEnabledAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/discovery?error=config");
  }
  await setDiscoveryTopicEnabled(operator.adminDb, {
    topicId: String(formData.get("topicId") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "true",
  });
  await insertBreakGlassAudit(operator.adminDb, {
    actorUserId: operator.session.user.id,
    action: "discovery.topic",
    targetType: "discovery_topic",
    targetId: String(formData.get("topicId") ?? ""),
  });
  redirect("/admin/discovery");
}

export async function setDiscoveredCreatorStateAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/discovery?error=config");
  }
  try {
    await setDiscoveredCreatorState(operator.adminDb, {
      id: String(formData.get("id") ?? ""),
      relevanceState: String(formData.get("relevanceState") ?? "") as
        | "candidate"
        | "monitored"
        | "excluded"
        | "low_confidence",
    });
    const state = String(formData.get("relevanceState") ?? "");
    await insertBreakGlassAudit(operator.adminDb, {
      actorUserId: operator.session.user.id,
      action: state === "excluded" ? "discovery.exclude" : "discovery.monitor",
      targetType: "discovered_creator",
      targetId: String(formData.get("id") ?? ""),
    });
  } catch {
    redirect("/admin/discovery?error=rejected");
  }
  redirect("/admin/discovery");
}

export async function triggerDiscoveryRunAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/discovery?error=config");
  }
  if (String(formData.get("confirm") ?? "") !== "yes") {
    redirect("/admin/discovery?error=rejected");
  }
  const providerKey = String(formData.get("providerKey") ?? "youtube");
  if (providerKey !== "youtube" && providerKey !== "reddit") {
    redirect("/admin/discovery?error=rejected");
  }
  try {
    await requestDiscoveryRun(operator.adminDb, {
      providerKey, query: String(formData.get("query") ?? ""),
      actorUserId: operator.session.user.id, confirm: true,
    });
  } catch (error) {
    if (error instanceof DiscoveryConfigurationError) redirect("/admin/discovery?error=configuration");
    throw error;
  }
  redirect("/admin/discovery?queued=yes");
}

export async function reviewQuarantineAction(formData: FormData) {
  const operator = await requireGrantedOperator();
  if (!operator.adminDb) {
    redirect("/admin/quarantine?error=config");
  }
  const kind = String(formData.get("kind") ?? "");
  try {
    if (kind === "intelligence") {
      await resolveIntelligenceQuarantine(operator.adminDb, {
        id: String(formData.get("id") ?? ""),
        actorUserId: operator.session.user.id,
        state: String(formData.get("action") ?? "") as "retried" | "resolved" | "dismissed",
        reason: String(formData.get("reason") ?? ""),
      });
    } else {
      await reviewMarketQuarantine(operator.adminDb, {
        quarantineId: String(formData.get("id") ?? ""),
        actorUserId: operator.session.user.id,
        action: String(formData.get("action") ?? "") as "retry" | "resolve_identity" | "dismiss",
        reason: String(formData.get("reason") ?? ""),
        printingId: String(formData.get("printingId") ?? "") || undefined,
        sourceNamespace: String(formData.get("sourceNamespace") ?? "") || undefined,
        identifierType: String(formData.get("identifierType") ?? "") || undefined,
        identifierValue: String(formData.get("identifierValue") ?? "") || undefined,
      });
    }
  } catch (error) {
    if (error instanceof ProviderAdminError) {
      redirect("/admin/quarantine?error=rejected");
    }
    throw error;
  }
  redirect("/admin/quarantine");
}
