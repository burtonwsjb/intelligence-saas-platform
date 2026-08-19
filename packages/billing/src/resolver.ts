import {
  getTenantBilling,
  listPlanCatalog,
  listTenantEntitlementOverrides,
  type Database,
} from "@isp/db";
import {
  assertFeature,
  assertWithinLimit,
  getLimit,
  hasFeature,
  resolveEntitlement,
  type EntitlementKey,
  type EntitlementValue,
} from "./entitlements.js";

export async function loadEntitlement(
  scoped: Database,
  organizationId: string,
  key: string,
): Promise<EntitlementValue> {
  const [billing, catalog, overrides] = await Promise.all([
    getTenantBilling(scoped, organizationId),
    listPlanCatalog(scoped),
    listTenantEntitlementOverrides(scoped, organizationId),
  ]);
  return resolveEntitlement({
    planKey: billing?.planKey ?? "free",
    status: billing?.status ?? "none",
    catalog: catalog.entitlements.map((row) => ({
      planKey: row.planKey,
      entitlementKey: row.entitlementKey,
      valueKind: row.valueKind,
      enabled: row.enabled,
      limitValue: row.limitValue,
    })),
    overrides: overrides.map((row) => ({
      planKey: billing?.planKey ?? "free",
      entitlementKey: row.entitlementKey,
      valueKind: row.valueKind,
      enabled: row.enabled,
      limitValue: row.limitValue,
    })),
    key,
  });
}

export async function tenantHasFeature(
  scoped: Database,
  organizationId: string,
  key: EntitlementKey,
): Promise<boolean> {
  return hasFeature(await loadEntitlement(scoped, organizationId, key));
}

export async function tenantLimit(
  scoped: Database,
  organizationId: string,
  key: EntitlementKey,
): Promise<number> {
  return getLimit(await loadEntitlement(scoped, organizationId, key));
}

export async function assertTenantFeature(
  scoped: Database,
  organizationId: string,
  key: EntitlementKey,
): Promise<void> {
  assertFeature(await loadEntitlement(scoped, organizationId, key));
}

export async function assertTenantWithinLimit(
  scoped: Database,
  organizationId: string,
  key: EntitlementKey,
  current: number,
): Promise<void> {
  assertWithinLimit(await loadEntitlement(scoped, organizationId, key), current);
}
