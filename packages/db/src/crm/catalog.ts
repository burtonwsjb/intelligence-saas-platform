export const LIFECYCLE_STAGES = [
  "lead",
  "signup",
  "onboarding",
  "activated",
  "trial",
  "customer",
  "at_risk",
  "past_due",
  "canceled",
  "churned",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CUSTOMER_STATUSES = [
  "lead",
  "signup",
  "trial",
  "active",
  "at_risk",
  "past_due",
  "canceled",
  "churned",
] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const CUSTOMER_EVENT_TYPES = [
  "user.signed_up",
  "organization.created",
  "onboarding.completed",
  "api_key.created",
  "first_event.ingested",
  "first_opportunity.viewed",
  "webhook.created",
  "subscription.started",
  "subscription.changed",
  "payment_failed",
  "subscription.canceled",
  "customer.reactivated",
] as const;

export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number];

export const OPERATOR_NOTE_CATEGORIES = [
  "account",
  "billing",
  "support",
  "sales",
  "risk",
  "other",
] as const;

export type OperatorNoteCategory = (typeof OPERATOR_NOTE_CATEGORIES)[number];

export const EXAMPLE_CRM_TAGS = [
  "trial",
  "high_usage",
  "developer",
  "vendor",
  "collector",
  "enterprise_candidate",
  "at_risk",
  "churned",
  "high_value",
] as const;

export const CHURN_REASON_CATEGORIES = [
  "too_expensive",
  "missing_features",
  "switched_product",
  "low_usage",
  "support",
  "other",
] as const;

export type ChurnReasonCategory = (typeof CHURN_REASON_CATEGORIES)[number];

export const ACTIVATION_RULE_VERSION = "activation.v1";

export const ACTIVATION_CRITERIA = [
  "organization_created",
  "first_api_key",
  "first_event_ingested",
  "first_intelligence_viewed",
  "first_webhook_configured",
] as const;

export type ActivationCriterion = (typeof ACTIVATION_CRITERIA)[number];

export const SEGMENT_RULE_VERSION = "segment.v1";

export const LIFECYCLE_ACTOR_TYPES = ["system", "user", "billing", "operator"] as const;

export type LifecycleActorType = (typeof LIFECYCLE_ACTOR_TYPES)[number];

export function isLifecycleStage(value: string): value is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

export function isCustomerEventType(value: string): value is CustomerEventType {
  return (CUSTOMER_EVENT_TYPES as readonly string[]).includes(value);
}

export function isOperatorNoteCategory(value: string): value is OperatorNoteCategory {
  return (OPERATOR_NOTE_CATEGORIES as readonly string[]).includes(value);
}

export function isChurnReasonCategory(value: string): value is ChurnReasonCategory {
  return (CHURN_REASON_CATEGORIES as readonly string[]).includes(value);
}
