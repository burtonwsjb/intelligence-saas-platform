import { isHostedRuntime } from "@isp/shared";
import { MissingDatabaseAdminUrlError } from "./errors.js";

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set. Database-dependent features cannot run until a Postgres connection string is configured.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}

export class MissingAppDatabaseUrlError extends Error {
  constructor() {
    super(
      "APP_DATABASE_URL is required in staging and production. Hosted web/API must use the restricted app_user connection and must not fall back to DATABASE_URL.",
    );
    this.name = "MissingAppDatabaseUrlError";
  }
}

export class MissingWorkerDatabaseUrlError extends Error {
  constructor() {
    super(
      "WORKER_DATABASE_URL is required in staging and production. The worker must not fall back to DATABASE_URL.",
    );
    this.name = "MissingWorkerDatabaseUrlError";
  }
}

/**
 * Web/API runtime URL.
 * Hosted staging/production require `APP_DATABASE_URL` (`app_user`) and never
 * fall back to a platform-managed `DATABASE_URL`.
 * Local/test prefer `APP_DATABASE_URL` when set, otherwise `DATABASE_URL`.
 */
export function requireDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const restricted = env.APP_DATABASE_URL?.trim();
  if (isHostedRuntime(env)) {
    if (!restricted) {
      throw new MissingAppDatabaseUrlError();
    }
    return restricted;
  }
  if (restricted) {
    return restricted;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new MissingDatabaseUrlError();
  }
  return url;
}

/**
 * Worker prefers `WORKER_DATABASE_URL` (`app_worker`).
 * Hosted staging/production require it and never fall back to `DATABASE_URL`.
 * Local/test may fall back to the web/API runtime resolver.
 */
export function requireWorkerDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const worker = env.WORKER_DATABASE_URL?.trim();
  if (isHostedRuntime(env)) {
    if (!worker) {
      throw new MissingWorkerDatabaseUrlError();
    }
    return worker;
  }
  return worker || requireDatabaseUrl(env);
}

export function requireDatabaseAdminUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_ADMIN_URL?.trim();
  if (!url) {
    throw new MissingDatabaseAdminUrlError();
  }
  return url;
}

export function isMissingDatabaseUrlError(
  error: unknown,
): error is MissingDatabaseUrlError | MissingAppDatabaseUrlError {
  return (
    error instanceof MissingDatabaseUrlError ||
    error instanceof MissingAppDatabaseUrlError
  );
}

export function isMissingWorkerDatabaseUrlError(
  error: unknown,
): error is MissingWorkerDatabaseUrlError {
  return error instanceof MissingWorkerDatabaseUrlError;
}

export {
  isMissingDatabaseAdminUrlError,
  MissingDatabaseAdminUrlError,
} from "./errors.js";
