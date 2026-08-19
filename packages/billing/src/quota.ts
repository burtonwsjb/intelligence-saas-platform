import { getMonthUsage, type Database } from "@isp/db";
import { QuotaExceededError, getLimit } from "./entitlements.js";
import { loadEntitlement } from "./resolver.js";

export const METER_TO_ENTITLEMENT = {
  "api.reads": "api_requests_per_month",
  "ingest.events": "api_requests_per_month",
  "decisions.generated": "predictions",
} as const;

export type MeterKey = keyof typeof METER_TO_ENTITLEMENT;

export async function evaluateQuota(
  scoped: Database,
  input: { organizationId: string; meterKey: MeterKey; at?: Date },
): Promise<{ current: number; limit: number; remaining: number }> {
  const entitlementKey = METER_TO_ENTITLEMENT[input.meterKey];
  const entitlement = await loadEntitlement(scoped, input.organizationId, entitlementKey);
  const current = await getMonthUsage(scoped, {
    organizationId: input.organizationId,
    meterKey: input.meterKey,
    at: input.at,
  });
  const limit = getLimit(entitlement);
  const remaining = Number.isFinite(limit) ? Math.max(limit - current, 0) : Number.POSITIVE_INFINITY;
  return { current, limit, remaining };
}

export async function assertQuota(
  scoped: Database,
  input: { organizationId: string; meterKey: MeterKey; at?: Date },
): Promise<void> {
  const snapshot = await evaluateQuota(scoped, input);
  if (Number.isFinite(snapshot.limit) && snapshot.current >= snapshot.limit) {
    throw new QuotaExceededError();
  }
}
