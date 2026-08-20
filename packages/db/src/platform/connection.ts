import { replaceConnectionRole } from "../bootstrap-roles.js";
import { requireDatabaseAdminUrl } from "../env.js";
import { DB_ROLES } from "../roles.js";
import { isProductionEnv } from "./catalog.js";

export class PlatformAdminDbNotConfiguredError extends Error {
  constructor() {
    super(
      "Platform admin database role is not configured. Set DATABASE_ADMIN_URL and APP_ADMIN_PASSWORD. Production cannot use the migrate/superuser URL.",
    );
    this.name = "PlatformAdminDbNotConfiguredError";
  }
}

export function isPlatformAdminDbNotConfiguredError(
  error: unknown,
): error is PlatformAdminDbNotConfiguredError {
  return error instanceof PlatformAdminDbNotConfiguredError;
}

/**
 * Resolves the BYPASSRLS `app_admin` connection for break-glass work.
 * Local non-production may fall back to DATABASE_ADMIN_URL (Docker superuser)
 * when APP_ADMIN_PASSWORD is unset. Production requires the app_admin password.
 */
export function resolvePlatformAdminConnectionUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const adminUrl = env.DATABASE_ADMIN_URL?.trim();
  const password = env.APP_ADMIN_PASSWORD?.trim();
  if (adminUrl && password) {
    return replaceConnectionRole(adminUrl, DB_ROLES.admin, password);
  }
  if (!isProductionEnv(env) && adminUrl) {
    return adminUrl;
  }
  throw new PlatformAdminDbNotConfiguredError();
}

export function requirePlatformAdminConnectionUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!env.DATABASE_ADMIN_URL?.trim()) {
    throw new PlatformAdminDbNotConfiguredError();
  }
  return resolvePlatformAdminConnectionUrl(env);
}

export { requireDatabaseAdminUrl };
