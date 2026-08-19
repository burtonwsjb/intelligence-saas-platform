import type { Context, MiddlewareHandler, Next } from "hono";
import { eq } from "drizzle-orm";
import {
  createDbFromEnv,
  isMissingDatabaseUrlError,
  tenant,
  touchApiKeyLastUsed,
  withMachineContext,
  type Database,
} from "@isp/db";
import {
  ApiKeyDeniedError,
  MissingApiKeyPepperError,
  hasScope,
  requireApiKeyPepper,
  verifyPresentedApiKey,
} from "@isp/auth";
import { jsonError } from "./errors.js";

export type MachinePrincipal = {
  organizationId: string;
  apiKeyId: string;
  scopes: string[];
};

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function createMachineAuth(options?: {
  db?: Database;
  env?: NodeJS.ProcessEnv;
}): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (c.req.path === "/v1/openapi.json") {
      return next();
    }
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return jsonError("unauthorized", "Authentication required.", 401);
    }
    let db: Database;
    let pepper: string;
    try {
      db = options?.db ?? createDbFromEnv(options?.env);
      pepper = requireApiKeyPepper(options?.env);
    } catch (error) {
      if (isMissingDatabaseUrlError(error) || error instanceof MissingApiKeyPepperError) {
        return jsonError("unauthorized", "Authentication required.", 401);
      }
      throw error;
    }
    let verified;
    try {
      verified = await verifyPresentedApiKey(db, token, pepper);
    } catch (error) {
      if (error instanceof ApiKeyDeniedError) {
        return jsonError("unauthorized", "Authentication required.", 401);
      }
      throw error;
    }
    try {
      await withMachineContext(
        db,
        { organizationId: verified.organizationId, apiKeyId: verified.id },
        async (scoped) => {
          const [row] = await scoped
            .select({ status: tenant.status })
            .from(tenant)
            .where(eq(tenant.organizationId, verified.organizationId))
            .limit(1);
          if (!row || row.status !== "active") {
            throw new TenantInactiveMachineError();
          }
          await touchApiKeyLastUsed(scoped, {
            id: verified.id,
            organizationId: verified.organizationId,
          });
        },
      );
    } catch (error) {
      if (error instanceof TenantInactiveMachineError) {
        return jsonError("tenant_suspended", "Tenant is not available.", 403);
      }
      throw error;
    }
    c.set("db", db);
    c.set("machine", {
      organizationId: verified.organizationId,
      apiKeyId: verified.id,
      scopes: verified.scopes.split(",").filter(Boolean),
    });
    await next();
  };
}

class TenantInactiveMachineError extends Error {
  constructor() {
    super("inactive");
    this.name = "TenantInactiveMachineError";
  }
}

export function requireScope(scope: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const machine = c.get("machine") as MachinePrincipal | undefined;
    if (!machine || !hasScope(machine.scopes, scope)) {
      return jsonError("scope_denied", "Scope denied.", 403);
    }
    return next();
  };
}
