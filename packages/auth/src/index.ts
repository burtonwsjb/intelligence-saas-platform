export {
  createAuth,
  isMissingAuthSecretError,
  MissingAuthSecretError,
  requireAuthSecret,
  type Auth,
  type AuthEnv,
} from "./auth.js";
export {
  createEmailDelivery,
  createMemoryInbox,
  type EmailDelivery,
  type VerificationMessage,
} from "./email.js";
export {
  EMAIL_TEMPLATE_KEYS,
  EmailNotConfiguredError,
  FixtureEmailProvider,
  LocalEmailProvider,
  ResendEmailProvider,
  createEmailProvider,
  escapeHtml,
  renderEmailTemplate,
  type EmailProvider,
  type EmailTemplateKey,
} from "./mail/index.js";
export {
  ac,
  admin,
  analyst,
  billing,
  developer,
  marketing,
  organizationRoles,
  owner,
  viewer,
  type OrganizationRoleName,
} from "./permissions.js";
export {
  hasPermission,
  parseOrganizationRoles,
  PERMISSIONS,
  PermissionDeniedError,
  requirePermission,
  resolveOrganizationRole,
  UnknownRoleError,
  type PermissionName,
} from "./rbac.js";
export {
  AuthRequiredError,
  OrganizationAccessError,
  OrganizationRequiredError,
  requireActiveOrganization,
  requireSession,
} from "./session.js";
export { ensureTenantRow } from "./tenant.js";
export {
  ApiKeyDeniedError,
  ISSUABLE_SCOPES,
  InvalidApiKeyNameError,
  KNOWN_SCOPES,
  MissingApiKeyPepperError,
  UnknownScopeError,
  createTenantApiKey,
  generateApiKeySecret,
  hasScope,
  hashApiKeySecret,
  parsePresentedApiKey,
  parseScopes,
  requireApiKeyPepper,
  revokeTenantApiKey,
  rotateTenantApiKey,
  verifyPresentedApiKey,
  type IssuableScope,
  type KnownScope,
} from "./api-key.js";
export {
  assertTenantActive,
  authorizeOrganizationSwitch,
  loadTenantStatus,
  organizationIdInput,
  recordOrganizationSwitch,
  requireUsableTenant,
  TenantInactiveError,
  TenantNotFoundError,
  type TenantStatus,
} from "./tenant-access.js";
