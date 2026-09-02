import { pastDueGraceEndsAt } from "./policy.js";
import { normalizeSubscriptionStatus, type SubscriptionStatus } from "./subscription.js";

export function shouldApplyStripeEvent(input: {
  lastAppliedCreated: number | null | undefined;
  incomingCreated: number;
}): boolean {
  if (input.lastAppliedCreated == null) {
    return true;
  }
  return input.incomingCreated >= input.lastAppliedCreated;
}

export function stripeCreatedFromAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): number | null {
  const raw = metadata?.stripe_created;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export type StripeBillingPatch = {
  planKey: string;
  status: SubscriptionStatus;
  pastDueSince: Date | null;
  graceEndsAt: Date | null;
  canceledAt: Date | null;
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
};

export function billingPatchFromStripeEvent(input: {
  eventType: string;
  status: string;
  planKey: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  existing: {
    pastDueSince?: Date | null;
    graceEndsAt?: Date | null;
    canceledAt?: Date | null;
    trialStartedAt?: Date | null;
    trialEndsAt?: Date | null;
  };
}): StripeBillingPatch {
  const now = input.now ?? new Date();
  const status =
    input.eventType === "customer.subscription.deleted"
      ? "canceled"
      : normalizeSubscriptionStatus(input.status);
  const planKey = status === "canceled" || input.eventType === "customer.subscription.deleted" ? "free" : input.planKey;

  if (status === "past_due" || input.eventType === "invoice.payment_failed") {
    const pastDueSince = input.existing.pastDueSince ?? now;
    return {
      planKey,
      status: "past_due",
      pastDueSince,
      graceEndsAt: input.existing.graceEndsAt ?? pastDueGraceEndsAt(pastDueSince, input.env),
      canceledAt: input.existing.canceledAt ?? null,
      trialStartedAt: input.existing.trialStartedAt ?? null,
      trialEndsAt: input.existing.trialEndsAt ?? null,
    };
  }

  if (status === "canceled") {
    return {
      planKey: "free",
      status: "canceled",
      pastDueSince: null,
      graceEndsAt: null,
      canceledAt: input.existing.canceledAt ?? now,
      trialStartedAt: input.existing.trialStartedAt ?? null,
      trialEndsAt: input.existing.trialEndsAt ?? null,
    };
  }

  if (status === "trialing") {
    return {
      planKey,
      status,
      pastDueSince: null,
      graceEndsAt: null,
      canceledAt: null,
      trialStartedAt: input.existing.trialStartedAt ?? now,
      trialEndsAt: input.existing.trialEndsAt ?? null,
    };
  }

  return {
    planKey,
    status,
    pastDueSince: null,
    graceEndsAt: null,
    canceledAt: null,
    trialStartedAt: input.existing.trialStartedAt ?? null,
    trialEndsAt: input.existing.trialEndsAt ?? null,
  };
}
