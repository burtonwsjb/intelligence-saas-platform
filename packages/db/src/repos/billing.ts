import { eq, sql } from "drizzle-orm";
import { assertTenantContext } from "../rls.js";
import {
  plan,
  planEntitlement,
  tenantBilling,
  tenantEntitlementOverride,
} from "../schema/billing.js";
import type { Database } from "../client.js";

export async function ensureTenantBilling(
  scoped: Database,
  organizationId: string,
): Promise<void> {
  await assertTenantContext(scoped);
  const [existing] = await scoped
    .select({ organizationId: tenantBilling.organizationId })
    .from(tenantBilling)
    .where(eq(tenantBilling.organizationId, organizationId))
    .limit(1);
  if (existing) {
    return;
  }
  await scoped.insert(tenantBilling).values({
    organizationId,
    planKey: "free",
    status: "none",
  });
}

export async function getTenantBilling(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  const [row] = await scoped
    .select()
    .from(tenantBilling)
    .where(eq(tenantBilling.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

export async function listPlanCatalog(scoped: Database) {
  await assertTenantContext(scoped);
  const plans = await scoped.select().from(plan);
  const entitlements = await scoped.select().from(planEntitlement);
  return { plans, entitlements };
}

export async function listTenantEntitlementOverrides(
  scoped: Database,
  organizationId: string,
) {
  await assertTenantContext(scoped);
  return scoped
    .select()
    .from(tenantEntitlementOverride)
    .where(eq(tenantEntitlementOverride.organizationId, organizationId));
}

export async function upsertTenantEntitlementOverride(
  scoped: Database,
  input: {
    organizationId: string;
    entitlementKey: string;
    valueKind: string;
    enabled: boolean;
    limitValue?: number | null;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped
    .insert(tenantEntitlementOverride)
    .values({
      organizationId: input.organizationId,
      entitlementKey: input.entitlementKey,
      valueKind: input.valueKind,
      enabled: input.enabled,
      limitValue: input.limitValue ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        tenantEntitlementOverride.organizationId,
        tenantEntitlementOverride.entitlementKey,
      ],
      set: {
        valueKind: input.valueKind,
        enabled: input.enabled,
        limitValue: input.limitValue ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function upsertTenantBilling(
  scoped: Database,
  input: {
    organizationId: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    planKey: string;
    status: string;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  },
): Promise<void> {
  await assertTenantContext(scoped);
  await scoped
    .insert(tenantBilling)
    .values({
      organizationId: input.organizationId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      planKey: input.planKey,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tenantBilling.organizationId,
      set: {
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        planKey: input.planKey,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
        updatedAt: new Date(),
      },
    });
}

export async function findOrganizationIdByStripeCustomer(
  db: Database,
  stripeCustomerId: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    select app.lookup_organization_by_stripe_customer(${stripeCustomerId}) as organization_id
  `);
  const row = Array.isArray(result)
    ? (result[0] as { organization_id?: string | null; organizationId?: string | null } | undefined)
    : "rows" in (result as object)
      ? (result as { rows: { organization_id?: string | null; organizationId?: string | null }[] }).rows[0]
      : undefined;
  const organizationId = row?.organization_id ?? row?.organizationId;
  return organizationId ?? null;
}

export async function claimStripeEvent(
  db: Database,
  input: {
    id: string;
    type: string;
    organizationId?: string | null;
    stripeCustomerId?: string | null;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    select app.claim_stripe_event(
      ${input.id},
      ${input.type},
      ${input.organizationId ?? null},
      ${input.stripeCustomerId ?? null}
    ) as claimed
  `);
  const row = Array.isArray(result)
    ? (result[0] as { claimed?: boolean } | undefined)
    : "rows" in (result as object)
      ? ((result as { rows: { claimed?: boolean }[] }).rows[0])
      : undefined;
  return Boolean(row?.claimed);
}
