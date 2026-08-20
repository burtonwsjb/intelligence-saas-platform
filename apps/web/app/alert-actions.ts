"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import {
  ALERT_RULE_TYPES,
  InvalidAlertRuleError,
  createAlertRule,
  deleteAlertRule,
  setAlertRuleEnabled,
  withOrganizationContext,
} from "@isp/db";
import { tenantHasFeature } from "@isp/billing";

function parseConfig(ruleType: string, formData: FormData): Record<string, unknown> {
  if (ruleType === "opportunity_score_threshold") {
    return { threshold: Number(formData.get("threshold")) };
  }
  if (ruleType === "price_move" || ruleType === "usage_threshold") {
    return { percent: Number(formData.get("percent")) };
  }
  return {};
}

async function requireAlerts() {
  const actor = await loadAppAccess();
  const entitled = await withOrganizationContext(
    getDb(),
    { organizationId: actor.organizationId, userId: actor.userId },
    (scoped) => tenantHasFeature(scoped, actor.organizationId, "alerts"),
  );
  if (!entitled) {
    redirect("/app/alerts?error=entitlement");
  }
  return actor;
}

export async function createAlertAction(formData: FormData) {
  const { organizationId, userId } = await requireAlerts();
  const ruleType = String(formData.get("ruleType") ?? "");
  if (!(ALERT_RULE_TYPES as readonly string[]).includes(ruleType)) {
    redirect("/app/alerts?error=type");
  }
  try {
    await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
      createAlertRule(scoped, {
        organizationId,
        createdByUserId: userId,
        ruleType,
        config: parseConfig(ruleType, formData),
        channelPreference: String(formData.get("channel") ?? "in_app"),
      }),
    );
  } catch (error) {
    if (error instanceof InvalidAlertRuleError) {
      redirect("/app/alerts?error=invalid");
    }
    throw error;
  }
  redirect("/app/alerts");
}

export async function toggleAlertAction(formData: FormData) {
  const { organizationId, userId } = await requireAlerts();
  await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    setAlertRuleEnabled(scoped, {
      organizationId,
      ruleId: String(formData.get("ruleId") ?? ""),
      enabled: String(formData.get("enabled") ?? "") === "true",
    }),
  );
  redirect("/app/alerts");
}

export async function deleteAlertAction(formData: FormData) {
  const { organizationId, userId } = await requireAlerts();
  await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    deleteAlertRule(scoped, {
      organizationId,
      ruleId: String(formData.get("ruleId") ?? ""),
    }),
  );
  redirect("/app/alerts");
}
