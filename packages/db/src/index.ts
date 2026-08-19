export {
  createDb,
  createDbConnection,
  createDbFromEnv,
  type Database,
} from "./client.js";
export {
  isMissingDatabaseAdminUrlError,
  isMissingDatabaseUrlError,
  MissingDatabaseAdminUrlError,
  MissingDatabaseUrlError,
  requireDatabaseAdminUrl,
  requireDatabaseUrl,
} from "./env.js";
export {
  InvalidTenantContextError,
  MissingTenantContextError,
} from "./errors.js";
export { applyMigrations } from "./migrate-lib.js";
export { bootstrapRoles, replaceConnectionRole } from "./bootstrap-roles.js";
export { listMigrationFiles, readMigrationSql } from "./migrations.js";
export { DB_ROLES } from "./roles.js";
export {
  assertContextId,
  assertTenantContext,
  parseOrganizationContext,
  withMachineContext,
  withOrganizationContext,
  withSystemContext,
  withTenantScope,
  type MachineContext,
  type OrganizationContext,
  type SystemContext,
} from "./rls.js";
export { insertAuditEvent, listAuditEvents } from "./repos/audit.js";
export { getTenant } from "./repos/tenant.js";
export {
  deleteTenantResource,
  insertTenantResource,
  listTenantResources,
  updateTenantResource,
} from "./repos/tenant-resource.js";
export {
  claimStripeEvent,
  ensureTenantBilling,
  findOrganizationIdByStripeCustomer,
  getTenantBilling,
  listPlanCatalog,
  listTenantEntitlementOverrides,
  upsertTenantBilling,
  upsertTenantEntitlementOverride,
} from "./repos/billing.js";
export {
  countActiveApiKeys,
  insertApiKey,
  listApiKeys,
  lookupApiKeyByPrefix,
  revokeApiKey,
  touchApiKeyLastUsed,
  type ApiKeyLookup,
} from "./repos/api-key.js";
export { getMonthUsage, monthStartUtc, recordUsage } from "./repos/usage.js";
export {
  IllegalSourceEventTransitionError,
  findSourceEventByIdempotency,
  getSourceEvent,
  insertSourceEvent,
  listSourceEvents,
  updateSourceEventStatus,
} from "./repos/source-event.js";
export {
  getOutboxJob,
  insertOutboxJob,
  listOutboxJobs,
  listPendingOutboxRefs,
  markOutboxPublishFailed,
  markOutboxPublished,
} from "./repos/outbox.js";
export {
  canTransitionSourceEvent,
  isSourceEventStatus,
} from "./ingest-status.js";
export * from "./schema/index.js";
