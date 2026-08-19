export class MissingDatabaseAdminUrlError extends Error {
  constructor() {
    super(
      "DATABASE_ADMIN_URL is not set. Migrations and role bootstrap require the privileged connection.",
    );
    this.name = "MissingDatabaseAdminUrlError";
  }
}

export class InvalidTenantContextError extends Error {
  constructor() {
    super("Tenant context is missing or invalid.");
    this.name = "InvalidTenantContextError";
  }
}

export class MissingTenantContextError extends Error {
  constructor() {
    super("Tenant context is required.");
    this.name = "MissingTenantContextError";
  }
}

export function isMissingDatabaseAdminUrlError(
  error: unknown,
): error is MissingDatabaseAdminUrlError {
  return error instanceof MissingDatabaseAdminUrlError;
}
