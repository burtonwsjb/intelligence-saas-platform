import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { alertRule } from "../schema/notification.js";
import { isAlertRuleType, isNotificationChannel, type AlertRuleType } from "./catalog.js";

export class InvalidAlertRuleError extends Error {
  constructor(message = "Invalid alert rule.") {
    super(message);
    this.name = "InvalidAlertRuleError";
  }
}

function assertConfig(ruleType: AlertRuleType, config: Record<string, unknown>): void {
  if (ruleType === "opportunity_score_threshold") {
    if (typeof config.threshold !== "number" || config.threshold < 0 || config.threshold > 100) {
      throw new InvalidAlertRuleError("opportunity_score_threshold requires threshold 0..100.");
    }
  }
  if (ruleType === "price_move" && (typeof config.percent !== "number" || config.percent <= 0)) {
    throw new InvalidAlertRuleError("price_move requires a positive percent.");
  }
  if (ruleType === "usage_threshold") {
    if (typeof config.percent !== "number" || ![50, 80, 90, 100].includes(config.percent)) {
      throw new InvalidAlertRuleError("usage_threshold requires 50, 80, 90, or 100.");
    }
  }
}

export async function createAlertRule(
  scoped: Database,
  input: {
    organizationId: string;
    createdByUserId: string;
    ruleType: string;
    config?: Record<string, unknown>;
    channelPreference?: string;
  },
) {
  await assertTenantContext(scoped);
  if (!isAlertRuleType(input.ruleType)) {
    throw new InvalidAlertRuleError("Unknown alert rule type.");
  }
  const channel = input.channelPreference ?? "in_app";
  if (!isNotificationChannel(channel)) {
    throw new InvalidAlertRuleError("Unknown alert channel.");
  }
  const config = input.config ?? {};
  assertConfig(input.ruleType, config);
  const [row] = await scoped
    .insert(alertRule)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      ruleType: input.ruleType,
      config,
      channelPreference: channel,
      enabled: true,
    })
    .returning();
  return row!;
}

export async function listAlertRules(scoped: Database, organizationId: string) {
  await assertTenantContext(scoped);
  return scoped.select().from(alertRule).where(eq(alertRule.organizationId, organizationId));
}

export async function setAlertRuleEnabled(
  scoped: Database,
  input: { organizationId: string; ruleId: string; enabled: boolean },
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .update(alertRule)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(alertRule.id, input.ruleId), eq(alertRule.organizationId, input.organizationId)))
    .returning();
  return row ?? null;
}

export async function deleteAlertRule(
  scoped: Database,
  input: { organizationId: string; ruleId: string },
) {
  await assertTenantContext(scoped);
  await scoped
    .delete(alertRule)
    .where(and(eq(alertRule.id, input.ruleId), eq(alertRule.organizationId, input.organizationId)));
}
