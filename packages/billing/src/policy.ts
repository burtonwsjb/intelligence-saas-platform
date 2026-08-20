export const DEFAULT_TRIAL_DURATION_DAYS = 14;
export const PAST_DUE_GRACE_DAYS = 7;

export function trialDurationDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRIAL_DURATION_DAYS?.trim();
  if (!raw) {
    return DEFAULT_TRIAL_DURATION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
    return DEFAULT_TRIAL_DURATION_DAYS;
  }
  return parsed;
}

export function trialWindow(now = new Date(), env?: NodeJS.ProcessEnv) {
  const days = trialDurationDays(env);
  const start = now;
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return { trialStartedAt: start, trialEndsAt: end };
}

export type RetentionPolicy = {
  version: "retention.v1";
  deleteCustomerDataOnCancel: false;
  deleteCustomerDataOnPastDue: false;
  pastDueEntitlements: "free";
  canceledEntitlements: "free";
};

export const RETENTION_POLICY: RetentionPolicy = {
  version: "retention.v1",
  deleteCustomerDataOnCancel: false,
  deleteCustomerDataOnPastDue: false,
  pastDueEntitlements: "free",
  canceledEntitlements: "free",
};

export function pastDueGraceEndsAt(pastDueSince: Date, env?: NodeJS.ProcessEnv): Date {
  const raw = env?.PAST_DUE_GRACE_DAYS?.trim();
  const days = raw && Number.isInteger(Number(raw)) ? Number(raw) : PAST_DUE_GRACE_DAYS;
  return new Date(pastDueSince.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000);
}
