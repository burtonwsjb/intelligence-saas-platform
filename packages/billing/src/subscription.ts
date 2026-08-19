export const SUBSCRIPTION_STATUSES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function normalizeSubscriptionStatus(
  status: string | null | undefined,
): SubscriptionStatus {
  if (status && (SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
    return status as SubscriptionStatus;
  }
  return "incomplete";
}

export function paidProductAccess(status: SubscriptionStatus): boolean {
  return status === "trialing" || status === "active";
}
