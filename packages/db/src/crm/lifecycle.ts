import { LIFECYCLE_STAGES, type LifecycleActorType, type LifecycleStage } from "./catalog.js";

export type { LifecycleActorType, LifecycleStage };

export class IllegalLifecycleTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Lifecycle cannot move from ${from} to ${to}.`);
    this.name = "IllegalLifecycleTransitionError";
  }
}

/**
 * Allowed lifecycle transitions. Billing subscription status is not this graph.
 * `lead` exists for pre-signup CRM rows that are not yet tenants.
 */
export const ALLOWED_LIFECYCLE_TRANSITIONS: Record<LifecycleStage, readonly LifecycleStage[]> = {
  lead: ["signup"],
  signup: ["onboarding", "trial"],
  onboarding: ["activated", "trial", "canceled"],
  activated: ["trial", "customer", "at_risk", "canceled"],
  trial: ["customer", "activated", "at_risk", "past_due", "canceled"],
  customer: ["at_risk", "past_due", "canceled"],
  at_risk: ["customer", "trial", "past_due", "canceled"],
  past_due: ["customer", "trial", "canceled", "churned"],
  canceled: ["churned", "customer", "trial"],
  churned: ["customer", "trial"],
};

export function canTransitionLifecycle(from: LifecycleStage, to: LifecycleStage): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertLifecycleTransition(from: LifecycleStage, to: LifecycleStage): void {
  if (!canTransitionLifecycle(from, to)) {
    throw new IllegalLifecycleTransitionError(from, to);
  }
}

export type BillingLifecycleHint = {
  status: string;
  planKey: string;
};

export type ActivationHint = {
  activated: boolean;
};

/**
 * Suggests a lifecycle stage from billing + activation. Callers must still
 * `transitionLifecycle` — this is not applied automatically as billing truth.
 */
export function suggestLifecycleStage(input: {
  current: LifecycleStage;
  billing: BillingLifecycleHint;
  activation: ActivationHint;
  atRisk?: boolean;
}): LifecycleStage {
  const status = input.billing.status;
  if (status === "canceled") {
    return input.current === "churned" ? "churned" : "canceled";
  }
  if (status === "past_due" || status === "unpaid") {
    return "past_due";
  }
  if (input.atRisk && (status === "active" || status === "trialing")) {
    return "at_risk";
  }
  if (status === "active" && input.billing.planKey !== "free") {
    return "customer";
  }
  if (status === "trialing") {
    return "trial";
  }
  if (input.activation.activated) {
    return "activated";
  }
  if (input.current === "lead") {
    return "signup";
  }
  if (input.current === "signup") {
    return "onboarding";
  }
  return input.current;
}

export function customerStatusForStage(stage: LifecycleStage): string {
  switch (stage) {
    case "lead":
      return "lead";
    case "signup":
    case "onboarding":
      return "signup";
    case "trial":
      return "trial";
    case "activated":
    case "customer":
      return "active";
    case "at_risk":
      return "at_risk";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "churned":
      return "churned";
  }
}

export function isLifecycleActorType(value: string): value is LifecycleActorType {
  return value === "system" || value === "user" || value === "billing" || value === "operator";
}

export function parseLifecycleStage(value: string): LifecycleStage {
  if ((LIFECYCLE_STAGES as readonly string[]).includes(value)) {
    return value as LifecycleStage;
  }
  return "signup";
}
