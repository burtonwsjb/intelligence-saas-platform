export const PLAN_KEYS = ["free", "starter", "growth", "scale"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const ENTITLEMENT_KEYS = [
  "api_requests_per_month",
  "api_keys",
  "team_members",
  "projects",
  "history_depth_days",
  "predictions",
  "creator_analytics",
  "content_generation",
  "alerts",
  "webhooks",
  "exports",
  "premium_data",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementValue = {
  key: EntitlementKey;
  kind: "boolean" | "limit";
  enabled: boolean;
  limit: number | null;
};

export type EntitlementRow = {
  planKey: string;
  entitlementKey: string;
  valueKind: string;
  enabled: boolean;
  limitValue: number | null;
};

export const PAID_ACCESS_STATUSES = new Set(["trialing", "active"]);

export function isKnownPlan(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

export function isKnownEntitlement(value: string): value is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

export function hasPaidAccess(status: string | null | undefined): boolean {
  return PAID_ACCESS_STATUSES.has(status ?? "");
}

export function effectivePlanKey(
  storedPlanKey: string | null | undefined,
  status: string | null | undefined,
): PlanKey {
  if (!hasPaidAccess(status) || !storedPlanKey || !isKnownPlan(storedPlanKey)) {
    return "free";
  }
  return storedPlanKey;
}

export function resolveEntitlement(
  input: {
    planKey: string;
    status?: string | null;
    catalog: EntitlementRow[];
    overrides?: EntitlementRow[];
    key: string;
  },
): EntitlementValue {
  if (!isKnownEntitlement(input.key)) {
    return { key: "api_requests_per_month", kind: "boolean", enabled: false, limit: 0 };
  }
  const planKey = effectivePlanKey(input.planKey, input.status);
  const override = input.overrides?.find((row) => row.entitlementKey === input.key);
  const base = input.catalog.find(
    (row) => row.planKey === planKey && row.entitlementKey === input.key,
  );
  const source = override ?? base;
  if (!source) {
    return { key: input.key, kind: "boolean", enabled: false, limit: 0 };
  }
  return {
    key: input.key,
    kind: source.valueKind === "limit" ? "limit" : "boolean",
    enabled: source.enabled,
    limit: source.limitValue,
  };
}

export function hasFeature(value: EntitlementValue): boolean {
  return value.enabled;
}

export function applyBetaSafetyCaps(
  value: EntitlementValue,
  env: NodeJS.ProcessEnv = process.env,
): EntitlementValue {
  const staging = env.ISP_ENV === "staging" || env.BETA_SAFETY_LIMITS?.trim() === "true";
  if (!staging) {
    return value;
  }
  if (value.key === "api_requests_per_month" && value.kind === "limit") {
    return { ...value, limit: Math.min(value.limit ?? 10_000, 10_000) };
  }
  if (value.key === "api_keys" && value.kind === "limit") {
    return { ...value, limit: Math.min(value.limit ?? 3, 3) };
  }
  if (value.key === "team_members" && value.kind === "limit") {
    return { ...value, limit: Math.min(value.limit ?? 5, 5) };
  }
  if (value.key === "webhooks" && value.kind === "limit") {
    return { ...value, limit: Math.min(value.limit ?? 2, 2) };
  }
  if (value.key === "content_generation") {
    return { ...value, enabled: false, limit: 0 };
  }
  return value;
}

export function getLimit(value: EntitlementValue): number {
  if (!value.enabled) {
    return 0;
  }
  if (value.kind !== "limit") {
    return value.enabled ? Number.POSITIVE_INFINITY : 0;
  }
  return value.limit ?? 0;
}

export class EntitlementDeniedError extends Error {
  readonly code = "entitlement_denied";
  constructor() {
    super("This feature is not included in the current plan.");
    this.name = "EntitlementDeniedError";
  }
}

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded";
  constructor() {
    super("Plan quota exceeded.");
    this.name = "QuotaExceededError";
  }
}

export function assertFeature(value: EntitlementValue): void {
  if (!hasFeature(value)) {
    throw new EntitlementDeniedError();
  }
}

export function assertWithinLimit(value: EntitlementValue, current: number): void {
  assertFeature(value);
  const limit = getLimit(value);
  if (Number.isFinite(limit) && current >= limit) {
    throw new QuotaExceededError();
  }
}
