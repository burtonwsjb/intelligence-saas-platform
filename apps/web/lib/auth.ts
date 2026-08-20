import "server-only";
import { nextCookies } from "better-auth/next-js";
import {
  createAuth,
  isMissingAuthSecretError,
  type Auth,
} from "@isp/auth";
import {
  createDbFromEnv,
  isMissingDatabaseUrlError,
  type Database,
} from "@isp/db";
import {
  InvalidRuntimeEnvError,
  assertHostedSecrets,
  defaultPublicOrigin,
} from "@isp/shared";

function readAuthEnv() {
  const origin = defaultPublicOrigin();
  return {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? origin,
    APP_URL: process.env.APP_URL ?? origin,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    AUTH_EMAIL_MODE: process.env.AUTH_EMAIL_MODE,
    ISP_ENV: process.env.ISP_ENV,
    BILLING_MODE: process.env.BILLING_MODE,
    PLATFORM_ADMIN_EMAILS: process.env.PLATFORM_ADMIN_EMAILS,
    QUEUE_PREFIX: process.env.QUEUE_PREFIX,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_TLS: process.env.REDIS_TLS,
  };
}

let cached:
  | {
      db: Database;
      auth: Auth;
    }
  | undefined;

export function isAuthConfigError(error: unknown): boolean {
  return (
    isMissingDatabaseUrlError(error) ||
    isMissingAuthSecretError(error) ||
    error instanceof InvalidRuntimeEnvError
  );
}

export function getAuth(): Auth {
  if (!cached) {
    assertHostedSecrets();
    const db = createDbFromEnv();
    cached = {
      db,
      auth: createAuth({
        db,
        env: readAuthEnv(),
        extraPlugins: [nextCookies()],
      }),
    };
  }
  return cached.auth;
}

export function tryGetAuth(): Auth | null {
  try {
    return getAuth();
  } catch (error) {
    if (isAuthConfigError(error)) {
      return null;
    }
    throw error;
  }
}

export function getDb() {
  if (!cached) {
    getAuth();
  }
  return cached!.db;
}

export { isMissingDatabaseUrlError };
