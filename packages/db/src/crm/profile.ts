import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertTenantContext } from "../rls.js";
import { crmLifecycleTransition, crmOrganizationProfile } from "../schema/crm.js";
import { ACTIVATION_RULE_VERSION } from "./catalog.js";
import { evaluateActivation } from "./activation.js";
import {
  assertLifecycleTransition,
  customerStatusForStage,
  parseLifecycleStage,
  type LifecycleActorType,
  type LifecycleStage,
} from "./lifecycle.js";

export async function getCrmOrganizationProfile(scoped: Database, organizationId: string) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(crmOrganizationProfile)
    .where(eq(crmOrganizationProfile.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export async function upsertCrmOrganizationProfile(
  scoped: Database,
  input: {
    organizationId: string;
    displayName: string;
    website?: string | null;
    industry?: string | null;
    primaryUseCase?: string | null;
    leadSource?: string | null;
    signupSource?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await assertTenantContext(scoped);
  const website = input.website?.trim() ? input.website.trim().slice(0, 200) : null;
  await scoped
    .insert(crmOrganizationProfile)
    .values({
      organizationId: input.organizationId,
      displayName: input.displayName.slice(0, 120),
      website,
      industry: input.industry ?? null,
      primaryUseCase: input.primaryUseCase ?? null,
      leadSource: input.leadSource ?? null,
      signupSource: input.signupSource ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: crmOrganizationProfile.organizationId,
      set: {
        displayName: input.displayName.slice(0, 120),
        website,
        industry: input.industry ?? null,
        primaryUseCase: input.primaryUseCase ?? null,
        leadSource: input.leadSource ?? null,
        signupSource: input.signupSource ?? null,
        metadata: input.metadata ?? {},
      },
    });
}

export async function transitionLifecycle(
  scoped: Database,
  input: {
    organizationId: string;
    toStage: LifecycleStage;
    reason: string;
    actorType: LifecycleActorType;
  },
): Promise<{ fromStage: LifecycleStage; toStage: LifecycleStage }> {
  await assertTenantContext(scoped);
  const profile = await getCrmOrganizationProfile(scoped, input.organizationId);
  const fromStage = parseLifecycleStage(profile?.lifecycleStage ?? "signup");
  assertLifecycleTransition(fromStage, input.toStage);
  if (fromStage !== input.toStage) {
    await scoped.insert(crmLifecycleTransition).values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      fromStage,
      toStage: input.toStage,
      reason: input.reason.slice(0, 200),
      actorType: input.actorType,
    });
  }
  const activation = await evaluateActivation(scoped, input.organizationId);
  const now = new Date();
  await scoped
    .update(crmOrganizationProfile)
    .set({
      lifecycleStage: input.toStage,
      customerStatus: customerStatusForStage(input.toStage),
      activatedAt:
        activation.activated && !profile?.activatedAt ? now : profile?.activatedAt ?? null,
      activationRuleVersion: activation.activated ? ACTIVATION_RULE_VERSION : profile?.activationRuleVersion,
      trialStartedAt:
        input.toStage === "trial" && !profile?.trialStartedAt ? now : profile?.trialStartedAt ?? null,
      convertedAt:
        input.toStage === "customer" && !profile?.convertedAt ? now : profile?.convertedAt ?? null,
      canceledAt:
        input.toStage === "canceled" || input.toStage === "churned"
          ? (profile?.canceledAt ?? now)
          : input.toStage === "customer" || input.toStage === "trial"
            ? null
            : profile?.canceledAt ?? null,
      lastActivityAt: now,
    })
    .where(eq(crmOrganizationProfile.organizationId, input.organizationId));
  return { fromStage, toStage: input.toStage };
}

export async function listLifecycleTransitions(scoped: Database, organizationId: string) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(crmLifecycleTransition)
    .where(eq(crmLifecycleTransition.organizationId, organizationId));
}
