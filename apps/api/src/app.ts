import { Hono } from "hono";
import { healthOk } from "@isp/contracts";
import { isNonEmptyString } from "@isp/shared";
import {
  createDbFromEnv,
  recordUsage,
  withMachineContext,
  type Database,
} from "@isp/db";
import {
  EntitlementDeniedError,
  InvalidStripeSignatureError,
  QuotaExceededError,
  StripeCustomerMismatchError,
  assertQuota,
  processStripeWebhook,
} from "@isp/billing";
import { createMachineAuth, requireScope, type MachinePrincipal } from "./machine-auth.js";
import { jsonError } from "./errors.js";

export function createApiApp(options?: {
  db?: import("@isp/db").Database;
  env?: NodeJS.ProcessEnv;
}) {
  const app = new Hono<{
    Variables: { db: Database; machine: MachinePrincipal };
  }>();
  const machineAuth = createMachineAuth(options);

  app.get("/health", (c) => {
    const body = healthOk();
    if (!isNonEmptyString(body.status)) {
      return new Response(JSON.stringify({ status: "error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return c.json(body);
  });

  app.post("/webhooks/stripe", async (c) => {
    const payload = await c.req.text();
    const signature = c.req.header("stripe-signature") ?? null;
    try {
      const db = options?.db ?? createDbFromEnv(options?.env);
      const result = await processStripeWebhook(db, {
        payload,
        signature,
        env: options?.env,
      });
      return c.json({ received: true, ...result });
    } catch (error) {
      if (error instanceof InvalidStripeSignatureError) {
        return jsonError("unauthorized", "Invalid signature.", 401);
      }
      if (error instanceof StripeCustomerMismatchError) {
        return jsonError("forbidden", "Webhook customer mismatch.", 403);
      }
      throw error;
    }
  });

  app.use("/v1/*", machineAuth);

  app.get("/v1/me", requireScope("decisions:read"), async (c) => {
    const machine = c.get("machine");
    const db = c.get("db");
    try {
      await withMachineContext(
        db,
        { organizationId: machine.organizationId, apiKeyId: machine.apiKeyId },
        async (scoped) => {
          await assertQuota(scoped, {
            organizationId: machine.organizationId,
            meterKey: "api.reads",
          });
          await recordUsage(scoped, {
            id: crypto.randomUUID(),
            organizationId: machine.organizationId,
            apiKeyId: machine.apiKeyId,
            meterKey: "api.reads",
            quantity: 1,
            idempotencyKey: c.req.header("idempotency-key") ?? crypto.randomUUID(),
          });
        },
      );
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return jsonError("quota_exceeded", "Plan quota exceeded.", 429);
      }
      if (error instanceof EntitlementDeniedError) {
        return jsonError("entitlement_denied", "Plan entitlement denied.", 402);
      }
      throw error;
    }
    return c.json({
      organization_id: machine.organizationId,
      api_key_id: machine.apiKeyId,
      scopes: machine.scopes,
    });
  });

  return app;
}

export const app = createApiApp();
