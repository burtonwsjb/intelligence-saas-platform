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

function readAuthEnv() {
  return {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    BETTER_AUTH_URL:
      process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000",
    APP_URL: process.env.APP_URL ?? "http://localhost:3000",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    AUTH_EMAIL_MODE: process.env.AUTH_EMAIL_MODE,
  };
}

let cached:
  | {
      db: Database;
      auth: Auth;
    }
  | undefined;

export function isAuthConfigError(error: unknown): boolean {
  return isMissingDatabaseUrlError(error) || isMissingAuthSecretError(error);
}

export function getAuth(): Auth {
  if (!cached) {
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
