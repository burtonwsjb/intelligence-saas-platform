import { sql } from "drizzle-orm";
import {
  recordCustomerEvent,
  suggestLifecycleStage,
  parseLifecycleStage,
  transitionLifecycle,
  upsertTenantBilling,
  upsertTenantEntitlementOverride,
  getCrmOrganizationProfile,
  insertAuditEvent,
  type Database,
} from "@isp/db";
import { isKnownPlan, type EntitlementKey } from "./entitlements.js";
import {
  LOCAL_BILLING_FIXTURES,
  type LocalBillingFixtureName,
  type SimulatedSubscriptionFixture,
} from "./fixtures.js";
import { requireLocalBillingSimulation } from "./mode.js";
import { pastDueGraceEndsAt, trialWindow } from "./policy.js";
import {
  normalizeSubscriptionStatus,
  type SubscriptionStatus,
} from "./subscription.js";

export {
  LOCAL_BILLING_FIXTURES,
  type LocalBillingFixtureName,
  type SimulatedSubscriptionFixture,
} from "./fixtures.js";

export class SimulatedBillingIsolationError extends Error {
  constructor() {
    super("Simulated billing cannot target a different tenant than the active context.");
    this.name = "SimulatedBillingIsolationError";
  }
}

export class InvalidSimulatedBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSimulatedBillingError";
  }
}

async function requireMatchingTenantContext(
  scoped: Database,
  organizationId: string,
): Promise<void> {
  const result = await scoped.execute(
    sql`select app.current_organization_id() as organization_id`,
  );
  const row = Array.isArray(result)
    ? (result[0] as { organization_id?: string | null } | undefined)
    : "rows" in (result as object)
      ? (result as { rows: { organization_id?: string | null }[] }).rows[0]
      : undefined;
  if (!row?.organization_id || row.organization_id !== organizationId) {
    throw new SimulatedBillingIsolationError();
  }
}

function fixtureFromInput(
  input: SimulatedSubscriptionFixture | { fixture: LocalBillingFixtureName },
): SimulatedSubscriptionFixture {
  if ("fixture" in input) {
    return LOCAL_BILLING_FIXTURES[input.fixture];
  }
  return input;
}

/**
 * Writes normalized tenant billing state for local/test databases only.
 * Never stores Stripe customer/subscription/price IDs. Not a public API.
 */
export async function simulateTenantSubscription(
  scoped: Database,
  input: {
    organizationId: string;
    env?: NodeJS.ProcessEnv;
  } & (SimulatedSubscriptionFixture | { fixture: LocalBillingFixtureName }),
): Promise<{ planKey: string; status: SubscriptionStatus }> {
  requireLocalBillingSimulation(input.env);
  await requireMatchingTenantContext(scoped, input.organizationId);
  const fixture = fixtureFromInput(input);
  if (!isKnownPlan(fixture.planKey)) {
    throw new InvalidSimulatedBillingError("Unknown plan key.");
  }
  const status = normalizeSubscriptionStatus(fixture.status);
  const now = new Date();
  const trial = status === "trialing" ? trialWindow(now, input.env) : { trialStartedAt: null, trialEndsAt: null };
  const canceledAt = status === "canceled" ? now : null;
  const pastDueSince = status === "past_due" ? now : null;
  await upsertTenantBilling(scoped, {
    organizationId: input.organizationId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    planKey: fixture.planKey,
    status,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: status === "canceled",
    trialStartedAt: trial.trialStartedAt,
    trialEndsAt: trial.trialEndsAt,
    canceledAt,
    pastDueSince,
    graceEndsAt: pastDueSince ? pastDueGraceEndsAt(pastDueSince, input.env) : null,
  });
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    action: "subscription.changed",
    targetType: "subscription",
    targetId: "local_simulation",
    metadata: { source: "local_simulation", status, planKey: fixture.planKey },
  });
  const eventType =
    status === "canceled"
      ? "subscription.canceled"
      : status === "past_due"
        ? "payment_failed"
        : status === "trialing" || status === "active"
          ? "subscription.started"
          : "subscription.changed";
  await recordCustomerEvent(scoped, {
    organizationId: input.organizationId,
    eventType,
    payload: { status, planKey: fixture.planKey, source: "local_simulation" },
  });
  const profile = await getCrmOrganizationProfile(scoped, input.organizationId);
  if (profile) {
    const suggested = suggestLifecycleStage({
      current: parseLifecycleStage(profile.lifecycleStage),
      billing: { status, planKey: fixture.planKey },
      activation: { activated: Boolean(profile.activatedAt) },
    });
    await transitionLifecycle(scoped, {
      organizationId: input.organizationId,
      toStage: suggested,
      reason: `billing.${status}`,
      actorType: "billing",
    });
  }
  return { planKey: fixture.planKey, status };
}

export async function simulateTenantEntitlementOverride(
  scoped: Database,
  input: {
    organizationId: string;
    entitlementKey: EntitlementKey;
    valueKind: "boolean" | "limit";
    enabled: boolean;
    limitValue?: number | null;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  requireLocalBillingSimulation(input.env);
  await requireMatchingTenantContext(scoped, input.organizationId);
  await upsertTenantEntitlementOverride(scoped, {
    organizationId: input.organizationId,
    entitlementKey: input.entitlementKey,
    valueKind: input.valueKind,
    enabled: input.enabled,
    limitValue: input.limitValue ?? null,
  });
  await insertAuditEvent(scoped, {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    action: "entitlement.override_changed",
    targetType: "entitlement",
    targetId: input.entitlementKey,
    metadata: { source: "local_simulation" },
  });
}
