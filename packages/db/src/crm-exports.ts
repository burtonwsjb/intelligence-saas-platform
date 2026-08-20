export {
  ACTIVATION_CRITERIA,
  ACTIVATION_RULE_VERSION,
  CHURN_REASON_CATEGORIES,
  CUSTOMER_EVENT_TYPES,
  CUSTOMER_STATUSES,
  EXAMPLE_CRM_TAGS,
  LIFECYCLE_STAGES,
  OPERATOR_NOTE_CATEGORIES,
  SEGMENT_RULE_VERSION,
} from "./crm/catalog.js";
export { evaluateActivation, evaluateActivationV1, collectActivationEvidence } from "./crm/activation.js";
export {
  ALLOWED_LIFECYCLE_TRANSITIONS,
  IllegalLifecycleTransitionError,
  assertLifecycleTransition,
  canTransitionLifecycle,
  customerStatusForStage,
  parseLifecycleStage,
  suggestLifecycleStage,
} from "./crm/lifecycle.js";
export { UnknownCustomerEventTypeError, hasCustomerEvent, listCustomerEvents, recordCustomerEvent } from "./crm/events.js";
export {
  getCrmOrganizationProfile,
  listLifecycleTransitions,
  transitionLifecycle,
  upsertCrmOrganizationProfile,
} from "./crm/profile.js";
export { getCrmUserProfile, upsertCrmUserProfile } from "./crm/user-profile.js";
export {
  OperatorNoteRejectedError,
  insertOperatorNote,
  listOperatorNotes,
  updateOperatorNote,
} from "./crm/notes.js";
export {
  InvalidCrmTagError,
  assignOrganizationTag,
  listCrmTags,
  listOrganizationTags,
  upsertCrmTag,
} from "./crm/tags.js";
export {
  evaluateSegmentMembership,
  insertSegmentDefinition,
  parseSegmentRules,
  profileMatchesSegment,
} from "./crm/segments.js";
export { evaluateCustomerHealth } from "./crm/health.js";
export { InvalidChurnReasonError, captureChurnReason, listChurnReasons } from "./crm/churn.js";
export {
  countCustomersByStage,
  listActiveCustomers,
  listAtRiskCustomers,
  listCanceledCustomers,
  listCrmCustomers,
  listCustomersByTag,
  listCustomersMissingActivity,
  listHighUsageCandidates,
  listInactiveCustomers,
  listPastDueCustomers,
  listRecentSignups,
  listTrialCustomers,
} from "./crm/admin.js";
export { ensureCrmOrganization } from "./crm/ensure.js";
